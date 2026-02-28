import { detectCity, detectKentuckyGeo } from './worker/src/lib/geo';
const text = 'Police in Corbin responded to a call';
console.log('detectCity', detectCity(text));
console.log('detectKentuckyGeo', detectKentuckyGeo(text));
