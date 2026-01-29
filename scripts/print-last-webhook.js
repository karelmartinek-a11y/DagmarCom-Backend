#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

db.all('SELECT payload FROM logs WHERE direction="IN" ORDER BY id DESC LIMIT 5', [], (err, rows) => {
  if (err) { console.error(err); process.exit(1); }
  rows.forEach((r,i)=>{
    console.log(`--- payload #${i+1} ---`);
    try { console.log(JSON.stringify(JSON.parse(r.payload), null, 2)); }
    catch { console.log(r.payload); }
  });
  process.exit(0);
});
