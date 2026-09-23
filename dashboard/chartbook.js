/* FishEdge LogBook — shared account-backed waypoint/measurement API. */
(function (global) {
  'use strict';
  const URL = 'https://wfdpfeptmyiqifgwqpzu.supabase.co';
  const KEY = 'sb_publishable_W6wnJkT70jb69JUZgM1dow_nabPZycR';
  const TABLE = 'logbook_items';
  let client = null;
  function getClient() {
    if (global.sb) return global.sb;
    if (!global.supabase?.createClient) return null;
    client ||= global.supabase.createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ocean-mvp-auth' } });
    return client;
  }
  function makeId() { return global.crypto?.randomUUID ? global.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function stableId(kind, geometry, scope = 'local') {
    const source = `${scope}:${kind}:${JSON.stringify(geometry)}`;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    const hex = (hash >>> 0).toString(16).padStart(8, '0');
    return `${hex}${hex}${hex}${hex}`.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  }
  async function session() { const c = getClient(); if (!c) return null; const { data } = await c.auth.getSession(); return data?.session || null; }
  const LOCAL_KEY = 'fishedge:logbook:v1';
  function dispatchChange() { try { global.dispatchEvent(new Event('fishedge-logbook-change')); } catch (_) {} }
  function localRows(scope) {
    try {
      const rows = JSON.parse(global.localStorage.getItem(LOCAL_KEY) || '[]');
      return (Array.isArray(rows) ? rows : []).filter(row => (row.owner_scope || 'local') === scope);
    } catch (_) { return []; }
  }
  function allLocalRows() { try { const rows = JSON.parse(global.localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch (_) { return []; } }
  function writeLocal(rows) { try { global.localStorage.setItem(LOCAL_KEY, JSON.stringify(rows)); dispatchChange(); return true; } catch (_) { return false; } }
  async function retryPending(scope, client, userId) {
    const pending = localRows(scope).filter(row => row.pending_sync);
    if (!pending.length || !client || !userId) return [];
    const payload = pending.map(({ owner_scope, pending_sync, ...row }) => ({ ...row, user_id: userId }));
    const result = await client.from(TABLE).upsert(payload, { onConflict: 'id' }).select();
    if (result.error) return [];
    const ids = new Set(pending.map(row => row.id));
    writeLocal(allLocalRows().filter(row => !ids.has(row.id)));
    return result.data || payload;
  }
  async function save(kind, items, title) {
    const s = await session();
    const scope = s?.user?.id || 'local';
    const rows = items.map(item => ({ id: item.id || stableId(kind, item.geometry, scope), user_id: s?.user?.id || null, owner_scope: scope, kind, title: item.title || title || (kind === 'waypoint' ? 'Waypoint' : 'Distance'), geometry: item.geometry, metadata: item.metadata || {}, updated_at: new Date().toISOString(), pending_sync: false }));
    const serverRows = rows.map(({ owner_scope, pending_sync, ...row }) => row);
    const c = getClient();
    if (s && c) {
      const result = await c.from(TABLE).upsert(serverRows, { onConflict: 'id' }).select();
      if (!result.error) { writeLocal(allLocalRows().filter(row => !rows.some(next => next.id === row.id))); return { ok: true, data: result.data || serverRows, synced: true }; }
      if (result.error.code !== 'PGRST205') return { ok: false, reason: 'server', error: result.error };
    }
    const pendingRows = rows.map(row => ({ ...row, pending_sync: Boolean(s) }));
    const current = allLocalRows().filter(row => !pendingRows.some(next => next.id === row.id));
    if (!writeLocal(current.concat(pendingRows))) return { ok: false, reason: 'local_storage' };
    return { ok: true, data: pendingRows, synced: false, reason: s ? 'server_unavailable' : 'signed_out' };
  }
  async function list(kind) {
    const s = await session(); const c = getClient();
    if (s && c) {
      await retryPending(s.user.id, c, s.user.id);
      const { data, error } = await c.from(TABLE).select('*').eq('user_id', s.user.id).eq('kind', kind).order('updated_at', { ascending: false });
      if (!error) return { ok: true, data: data || [], synced: true };
      if (error.code !== 'PGRST205') return { ok: false, reason: 'server', data: [], error };
    }
    return { ok: true, data: localRows(s?.user?.id || 'local').filter(row => row.kind === kind), synced: false, reason: s ? 'server_unavailable' : 'signed_out' };
  }
  global.addEventListener?.('storage', event => { if (event.key === LOCAL_KEY) dispatchChange(); });
  global.FishEdgeLogBook = { makeId, stableId, save, list };
})(window);
