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
  function localRows() { try { const rows = JSON.parse(global.localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch (_) { return []; } }
  function writeLocal(rows) { try { global.localStorage.setItem(LOCAL_KEY, JSON.stringify(rows)); } catch (_) {} }
  async function save(kind, items, title) {
    const s = await session();
    const scope = s?.user?.id || 'local';
    const rows = items.map(item => ({ id: item.id || stableId(kind, item.geometry, scope), user_id: s?.user?.id || null, kind, title: item.title || title || (kind === 'waypoint' ? 'Waypoint' : 'Distance'), geometry: item.geometry, metadata: item.metadata || {}, updated_at: new Date().toISOString() }));
    const c = getClient();
    if (s && c) {
      const result = await c.from(TABLE).upsert(rows, { onConflict: 'id' }).select();
      if (!result.error) return { ok: true, data: result.data || rows, synced: true };
      if (result.error.code !== 'PGRST205') return { ok: false, reason: 'server', error: result.error };
    }
    const current = localRows().filter(row => !rows.some(next => next.id === row.id));
    writeLocal(current.concat(rows));
    return { ok: true, data: rows, synced: false, reason: s ? 'server_unavailable' : 'signed_out' };
  }
  async function list(kind) {
    const s = await session(); const c = getClient();
    if (s && c) {
      const { data, error } = await c.from(TABLE).select('*').eq('user_id', s.user.id).eq('kind', kind).order('updated_at', { ascending: false });
      if (!error) return { ok: true, data: data || [], synced: true };
      if (error.code !== 'PGRST205') return { ok: false, reason: 'server', data: [], error };
    }
    return { ok: true, data: localRows().filter(row => row.kind === kind), synced: false, reason: s ? 'server_unavailable' : 'signed_out' };
  }
  global.FishEdgeLogBook = { makeId, stableId, save, list };
})(window);
