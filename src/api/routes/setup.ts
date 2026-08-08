import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { safeError } from '../../security/redaction.js';
import type { InstallationService } from '../../services/installation-service.js';

const connectionSchema = z
  .object({ baseUrl: z.string().min(1).max(2048), apiKey: z.string().min(1).max(4096) })
  .strict();
const selectionSchema = z.object({ radarrId: z.number().int().positive() }).strict();

function setupPage(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>scorerr installer</title><style>body{font:16px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;color:#18202a}fieldset{margin:1rem 0;padding:1rem;border:1px solid #ccd4dd;border-radius:8px}label{display:block;margin:.6rem 0}input,select{width:100%;box-sizing:border-box;padding:.55rem}button{padding:.65rem 1rem;margin:.4rem .4rem .4rem 0}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem;border-radius:8px}.warn{color:#8a5200}</style></head><body><h1>scorerr installer</h1><p class="warn">Interface d’administration sans authentification : réseau local de confiance uniquement.</p><fieldset><legend>1. Connexion Radarr</legend><label>URL<input id="ru" placeholder="http://radarr:7878"></label><label>API Key<input id="rk" type="password" autocomplete="off"></label><button onclick="testService('radarr')">Tester Radarr</button></fieldset><fieldset><legend>2. Connexion Seerr</legend><label>URL<input id="su" placeholder="http://seerr:5055"></label><label>API Key<input id="sk" type="password" autocomplete="off"></label><button onclick="testService('seerr')">Tester Seerr</button></fieldset><fieldset><legend>3. Diagnostic</legend><button onclick="diagnostic()">Analyser</button><div id="choice"></div><pre id="out">Aucun diagnostic.</pre><button onclick="applySetup()">Configurer automatiquement</button><button id="rollback" onclick="rollbackSetup()" hidden>Restaurer la configuration précédente</button></fieldset><script>
const out=document.getElementById('out');async function call(url,options){const r=await fetch(url,{...options,headers:{'content-type':'application/json'}});const j=await r.json();out.textContent=JSON.stringify(j,null,2);if(!r.ok)throw new Error(j.error||'Erreur');return j}async function testService(s){const p=s==='radarr'?'r':'s';await call('/api/setup/'+s+'/test',{method:'POST',body:JSON.stringify({baseUrl:document.getElementById(p+'u').value,apiKey:document.getElementById(p+'k').value})});document.getElementById(p+'k').value=''}async function diagnostic(id){const j=await call(id?'/api/setup/seerr/radarr-selection':'/api/setup/diagnostic',id?{method:'PUT',body:JSON.stringify({radarrId:id})}:{});const c=document.getElementById('choice');c.innerHTML='';if(j.status==='selection_required'){const s=document.createElement('select');j.seerr.instances.forEach(i=>s.add(new Option(i.name+' — '+i.url,i.id)));const b=document.createElement('button');b.textContent='Choisir cette instance';b.onclick=()=>diagnostic(Number(s.value));c.append(s,b)}await refresh()}async function applySetup(){await call('/api/setup/snapshot',{method:'POST',body:'{}'});await call('/api/setup/apply',{method:'POST',body:'{}'});await refresh()}async function rollbackSetup(){await call('/api/setup/rollback',{method:'POST',body:'{}'});await refresh()}async function refresh(){const r=await fetch('/api/setup/status');const j=await r.json();document.getElementById('rollback').hidden=!j.snapshotAvailable}refresh();</script></body></html>`;
}

export function registerSetupRoutes(app: FastifyInstance, service: InstallationService): void {
  app.get('/setup', (_request, reply) => reply.type('text/html; charset=utf-8').send(setupPage()));
  for (const target of ['radarr', 'seerr'] as const) {
    app.post(`/api/setup/${target}/test`, async (request, reply) => {
      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'Invalid setup connection payload' });
      const result = await service.testConnection(target, parsed.data.baseUrl, parsed.data.apiKey);
      return reply.code(result.connected ? 200 : 422).send(result);
    });
  }
  app.get('/api/setup/diagnostic', async () => service.diagnostic());
  app.get('/api/setup/probe', async () => service.probe());
  app.get('/api/setup/apply-preview', async () => service.applyPreview());
  app.post('/api/setup/radarr/test-webhook', async () => service.testWebhook());
  app.post('/api/setup/seerr/test-prevent-search', async () => service.testSeerrPreventSearch());
  app.post('/api/setup/seerr/restore-prevent-search', async () =>
    service.restoreSeerrPreventSearch(),
  );
  app.put('/api/setup/seerr/radarr-selection', async (request, reply) => {
    const parsed = selectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid Radarr selection' });
    return service.diagnostic(parsed.data.radarrId);
  });
  app.post('/api/setup/snapshot', () => service.createSnapshot());
  app.post('/api/setup/apply', async () => service.apply());
  app.post('/api/setup/rollback', async () => service.rollback());
  app.get('/api/setup/status', () => service.status());
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: statusCode === 413 ? 'Payload too large' : 'Invalid request' });
    }
    const safe = safeError(error);
    const status =
      safe.code === 'seerr_probe_write_disabled'
        ? 403
        : safe.code === 'writes_disabled' || safe.code === 'configuration_conflict'
          ? 409
          : safe.code === 'unauthorized'
            ? 401
            : 422;
    return reply.code(status).send({ error: safe.message, code: safe.code });
  });
}
