import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ReleaseProbeService } from '../../services/release-probe-service.js';

const movieParamsSchema = z.object({ movieId: z.coerce.number().int().positive() }).strict();
const probeParamsSchema = z.object({ probeId: z.coerce.number().int().positive() }).strict();

function page(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>scorerr release probe</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}input,button{padding:.6rem}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{border:1px solid #ccd4dd;padding:.4rem;text-align:left}pre{white-space:pre-wrap;background:#f4f6f8;padding:1rem}</style></head><body><h1>scorerr release probe</h1><p>Recherche interactive manuelle, sans grab ni téléchargement.</p><input id="movie" type="number" min="1" placeholder="movieId"><button id="run">Analyser les releases</button><p id="state">Prêt.</p><div id="summary"></div><table><thead><tr><th>Release</th><th>Quality</th><th>Protocol</th><th>Indexer</th><th>Size</th><th>Seeders</th><th>Leechers</th><th>Custom Format Score</th><th>Rejected</th></tr></thead><tbody id="rows"></tbody></table><pre id="raw"></pre><script>const state=document.getElementById('state'),rows=document.getElementById('rows'),raw=document.getElementById('raw'),summary=document.getElementById('summary');document.getElementById('run').onclick=async()=>{const id=Number(document.getElementById('movie').value);if(!id)return;state.textContent='Searching…';rows.innerHTML='';raw.textContent='';try{const response=await fetch('/api/probe/releases/'+id,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const report=await response.json();if(!response.ok)throw new Error(report.error||'Erreur');state.textContent=report.status+' — '+report.durationMs+' ms';summary.textContent=report.releaseCount+' release(s)';for(const item of report.releases||[]){const tr=document.createElement('tr');const values=[item.title,item.quality?.quality?.name??item.quality,item.protocol,item.indexer,item.size,item.seeders,item.leechers,item.customFormatScore,item.rejected];for(const value of values){const td=document.createElement('td');td.textContent=typeof value==='object'?JSON.stringify(value):String(value??'');tr.appendChild(td)}rows.appendChild(tr)}raw.textContent=JSON.stringify(report,null,2)}catch(error){state.textContent=String(error)}};</script></body></html>`;
}

export function registerReleaseProbeRoutes(
  app: FastifyInstance,
  service: ReleaseProbeService,
): void {
  app.get('/probe/releases', (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(page()),
  );
  app.post('/api/probe/releases/:movieId', async (request, reply) => {
    const parsed = movieParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid movieId' });
    return service.run(parsed.data.movieId);
  });
  app.get('/api/probe/releases/:probeId', (request, reply) => {
    const parsed = probeParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid probeId' });
    return service.get(parsed.data.probeId);
  });
}
