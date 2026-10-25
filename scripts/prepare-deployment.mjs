import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.resolve(project,'../../work');
const domain = process.argv[2] || 'reels.127.0.0.1.sslip.io';
if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error('Invalid domain');
const envPath = path.join(scratch,'server-studio.env');
await fs.mkdir(scratch,{recursive:true});
let password,existingEnv='';
try { existingEnv=await fs.readFile(envPath,'utf8');password=existingEnv.match(/^STUDIO_PASSWORD=(.+)$/m)?.[1]; }
catch(error) { if(error.code !== 'ENOENT') throw error; }
password ||= randomBytes(24).toString('base64url');
if(!existingEnv.trim())existingEnv=`STUDIO_DOMAIN=${domain}\nSTUDIO_USER=hec\nSTUDIO_PASSWORD=${password}\nANALYSIS_PROVIDER=codex\nMAX_STORAGE_MB=0\nSTORAGE_RESERVE_MB=3072\nRENDER_WIDTH=1080\n`;
else if(!existingEnv.match(/^STUDIO_PASSWORD=.+$/m))existingEnv=existingEnv.trimEnd()+`\nSTUDIO_PASSWORD=${password}\n`;
await fs.writeFile(envPath,existingEnv,{mode:0o600});
await fs.writeFile(path.resolve(project,'../Reel-Studio-Zugang.txt'),`HIGH ENERGY CIRCLE · REEL-STUDIO\n\nAdresse: https://${domain}\nStudio-Passwort: ${password}\n\nDas Passwort gehört zu deinem privaten Upload-Bereich.\nFür API-Anfragen: Benutzer hec + dieses Passwort als HTTP Basic Auth.\n\nCodex: Der Agent in diesem Chat übernimmt die Auswertung. Rechner und Codex müssen laufen.\n\nServer: /opt/hec-reel-studio\nDaten: siehe STUDIO_VOLUME_PATH und deploy/compose.storage.yml; bestehende Volume-Einstellungen bleiben erhalten.\n`,{mode:0o600});
console.log('Deployment settings and user access file prepared; credentials are not printed.');
