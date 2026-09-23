/* FishEdge Captain's Chartbook — shared account-backed waypoint/measurement API. */
(function (global) {
  'use strict';
  const URL = 'https://wfdpfeptmyiqifgwqpzu.supabase.co';
  const KEY = 'sb_publishable_W6wnJkT70jb69JUZgM1dow_nabPZycR';
  const TABLE = 'chartbook_items';
  let client = null;
  function getClient() {
    if (global.sb) return global.sb;
    if (!global.supabase?.createClient) return null;
    client ||= global.supabase.createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ocean-mvp-auth' } });
    return client;
  }
  function makeId() { return global.crypto?.randomUUID ? global.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function stableId(kind, geometry) {
    const source = `${kind}:${JSON.stringify(geometry)}`;
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    const hex = (hash >>> 0).toString(16).padStart(8, '0');
    return `${hex}${hex}${hex}${hex}`.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  }
  async function session() { const c = getClient(); if (!c) return null; const { data } = await c.auth.getSession(); return data?.session || null; }
  async function save(kind, items, title) {
    const s = await session();
    if (!s) return { ok: false, reason: 'signed_out' };
    const rows = items.map(item => ({ id: item.id || stableId(kind, item.geometry), user_id: s.user.id, kind, title: item.title || title || (kind === 'waypoint' ? 'Waypoint' : 'Distance'), geometry: item.geometry, metadata: item.metadata || {} }));
    const c = getClient();
    const { data, error } = await c.from(TABLE).upsert(rows, { onConflict: 'id' }).select();
    return error ? { ok: false, reason: 'server', error } : { ok: true, data: data || rows };
  }
  async function list(kind) {
    const s = await session(); if (!s) return { ok: false, reason: 'signed_out', data: [] };
    const c = getClient(); const { data, error } = await c.from(TABLE).select('*').eq('user_id', s.user.id).eq('kind', kind).order('updated_at', { ascending: false });
    return error ? { ok: false, reason: 'server', data: [], error } : { ok: true, data: data || [] };
  }
  global.FishEdgeChartbook = { makeId, stableId, save, list };
})(window);
