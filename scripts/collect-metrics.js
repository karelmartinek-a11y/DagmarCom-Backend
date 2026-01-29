#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function line(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch (e) {
    return '';
  }
}

function dfRoot() {
  const out = line("df -Pm / | awk 'NR==2{print $4" """"""","""""""$5}'");
  if (!out) return { free_mb: -1, used_pct: 'n/a' };
  const [free, usedPct] = out.split(',');
  return { free_mb: Number(free), used_pct: usedPct };
}

function du(pathname) {
  const out = line(`du -sm ${pathname}`);
  if (!out) return -1;
  const mb = out.split(/\s+/)[0];
  return Number(mb);
}

function certDays(pem) {
  const out = line(`openssl x509 -enddate -noout -in ${pem} | cut -d= -f2`);
  if (!out) return -1;
  const exp = Date.parse(out);
  if (!exp) return -1;
  return Math.floor((exp - Date.now()) / 86400000);
}

function parsePsGrep(name) {
  const out = line(`ps -C ${name} -o pid=,etime=`);
  return out ? out.split('\n').length : 0;
}

function main() {
  const metrics = {};
  const df = dfRoot();
  metrics.disk_free_mb = df.free_mb;
  metrics.disk_used_pct = df.used_pct;

  metrics.dagmar_db_mb = du('/var/lib/postgresql') >= 0 ? du('/var/lib/postgresql') : -1;
  metrics.hotel_db_mb = -1; // kept simple; main DB in docker volume
  metrics.hotel_media_mb = du('/var/lib/hotelapp/media');
  metrics.dagmar_media_mb = du('/var/lib/dagmar');

  metrics.cert_days = {
    api: certDays('/etc/letsencrypt/live/api.hcasc.cz/fullchain.pem'),
    dagmar: certDays('/etc/letsencrypt/live/dagmar.hcasc.cz-0002/fullchain.pem'),
    hotel: certDays('/etc/letsencrypt/live/hotel.hcasc.cz-0001/fullchain.pem'),
  };

  metrics.processes = {
    dagmar_backend: parsePsGrep('gunicorn'),
    dagmarcom_backend: parsePsGrep('node'),
    nginx: parsePsGrep('nginx'),
  };

  fs.writeFileSync(path.join(__dirname, '..', 'data', 'status-cache.json'), JSON.stringify(metrics));
}

main();
