// A megfogó szabály nevét a címből olvassuk ki.
//
// Külön fájl, nem inline szkript: a bővítmények alap tartalombiztonsági
// házirendje az inline szkriptet nem engedi futni — csendben, hibaüzenet
// nélkül. A lap ilyenkor betöltődne, csak épp nem mondaná meg, mi tiltotta le.
const rule = new URLSearchParams(location.search).get('rule');
document.getElementById('rule').textContent = rule && rule.trim() ? rule : 'ismeretlen szabály';
