// NYXMIX_* is the documented name for every setting; the older KLANG_* names keep working.
// Imported first by server/index.js so every module sees the mapped values.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('NYXMIX_')) process.env[`KLANG_${k.slice(7)}`] = v;
}
