#!/usr/bin/env node
/**
 * create-albums.mjs
 * Skapar ett Google Photos-album per person i stamtavlan.
 * Album namnges "Stavla: [Förnamn Efternamn]" för att hålla sig
 * separerade från dina privata album (Google Photos har inga mappar,
 * men prefix "Stavla:" gör dem lätta att filtrera i appen).
 *
 * KRAV:
 *   node >= 18  (inbyggd fetch)
 *
 * STEG INNAN DU KÖR:
 *   1. Gå till https://console.cloud.google.com/apis/library
 *      Sök "Photos Library API" → Aktivera för projektet stavla-a21d5
 *   2. Gå till APIs & Services → Credentials → Create Credentials → OAuth client ID
 *      Typ: Desktop app, namn: "Stavla album-script"
 *      Ladda ner JSON → spara som client_secret.json i samma mapp som detta script
 *   3. npm install googleapis   (eller: npm init -y && npm install googleapis)
 *   4. node create-albums.mjs
 *      Första gången öppnas en webbläsare för att godkänna → token sparas lokalt
 *
 * NOTERA:
 *   - Scriptet skapar INTE dubletter — album som redan heter "Stavla: X" hoppas över
 *   - Google Photos API tillåter max ~10 000 album per konto
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { URL } from 'url';
import open from 'open'; // npm install open

// ── Alla personer i stamtavlan (kopierat från P-objektet i index.html) ──
// Kör: node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const m=h.match(/const P = (\{[\s\S]*?\n\});/);console.log(m[1])" > persons.json
// Eller fyll i manuellt nedan:
const PERSONS = {
  // Lägg till eller ersätt med din faktiska lista — format: id: { n: "Namn" }
  // Scriptet extraherar dem automatiskt från index.html om den finns i samma mapp
};

// ── Extrahera personer från index.html automatiskt ──
function extractPersons() {
  if (!existsSync('index.html')) return PERSONS;
  const html = readFileSync('index.html', 'utf8');
  // Hitta P = { ... } blocket
  const match = html.match(/\bconst P\s*=\s*(\{[\s\S]*?\n\s*\});/);
  if (!match) { console.warn('Kunde inte hitta P-objektet i index.html'); return PERSONS; }
  try {
    // eval är ok här — vi kör lokalt på vår egen fil
    const fn = new Function('return ' + match[1]);
    return fn();
  } catch(e) {
    console.warn('Kunde inte tolka P-objektet:', e.message);
    return PERSONS;
  }
}

// ── OAuth2 setup ──
const SECRET_FILE = 'client_secret.json';
const TOKEN_FILE  = '.gphoto_token.json';

if (!existsSync(SECRET_FILE)) {
  console.error(`\nSaknar ${SECRET_FILE}.\nLadda ner OAuth-nyckeln från Google Cloud Console och spara som ${SECRET_FILE}\n`);
  process.exit(1);
}

const { installed: creds } = JSON.parse(readFileSync(SECRET_FILE, 'utf8'));
const oauth2Client = new google.auth.OAuth2(
  creds.client_id, creds.client_secret, 'http://localhost:8080'
);

async function getToken() {
  if (existsSync(TOKEN_FILE)) {
    const tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    oauth2Client.setCredentials(tokens);
    return;
  }
  // Öppna webbläsare för auth
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/photoslibrary']
  });
  console.log('\nÖppnar webbläsare för Google-inloggning...');
  await open(authUrl);

  // Vänta på callback
  const code = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:8080');
      const code = url.searchParams.get('code');
      res.end('<h2>Klart! Du kan stänga det här fönstret.</h2>');
      server.close();
      resolve(code);
    }).listen(8080);
    console.log('Väntar på inloggning...');
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  console.log('Token sparad.\n');
}

async function photosRequest(method, path, body) {
  const { token } = await oauth2Client.getAccessToken();
  const url = 'https://photoslibrary.googleapis.com/v1' + path;
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function getExistingAlbums() {
  const existing = new Set();
  let pageToken;
  do {
    const url = '/albums?pageSize=50' + (pageToken ? '&pageToken=' + pageToken : '');
    const data = await photosRequest('GET', url);
    (data.albums || []).forEach(a => existing.add(a.title));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return existing;
}

async function createAlbum(title) {
  const data = await photosRequest('POST', '/albums', { album: { title } });
  return data.id;
}

// ── Huvud ──
async function main() {
  await getToken();

  const persons = extractPersons();
  const names = Object.values(persons)
    .map(p => p.n)
    .filter(Boolean)
    .filter((n, i, arr) => arr.indexOf(n) === i) // unika
    .sort();

  console.log(`Hittade ${names.length} unika personer.\n`);

  console.log('Hämtar befintliga album...');
  const existing = await getExistingAlbums();
  const stavlaExisting = [...existing].filter(t => t.startsWith('Stavla:'));
  console.log(`${stavlaExisting.length} Stavla-album finns redan.\n`);

  let created = 0, skipped = 0;
  for (const name of names) {
    const title = 'Stavla: ' + name;
    if (existing.has(title)) {
      console.log(`  ⏭  ${title} (finns redan)`);
      skipped++;
      continue;
    }
    try {
      await createAlbum(title);
      console.log(`  ✓  ${title}`);
      created++;
      // Google Photos API rate limit: ~1 req/sek rekommenderas
      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`  ✗  ${title}: ${e.message}`);
    }
  }

  console.log(`\nKlart! ${created} album skapade, ${skipped} hoppades över.`);
  console.log('Album syns nu i Google Photos under "Album" med prefix "Stavla:".');
}

main().catch(e => { console.error(e); process.exit(1); });
