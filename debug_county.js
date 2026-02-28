const { detectCounty } = require('./worker/src/lib/geo');
const text = "Laurel and Knox County's Commonwealth's Attorney";
console.log('normalized text:', text.toLowerCase());
console.log('detectCounty ->', detectCounty(text, text));
