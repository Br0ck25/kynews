function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizeForSearch(input) {
  return ` ${input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `.replace(/\s+/g, ' ');
}
const text = "Laurel and Knox County's Commonwealth's Attorney";
const normalized = normalizeForSearch(text);
console.log('normalized:', JSON.stringify(normalized));
const county = 'Knox';
const escaped = escapeRegExp(county.toLowerCase());
const pattern = new RegExp(`\\b${escaped}\\s+(?:county|counties|cnty|co(?=[\\s]|$))\\b`, 'gi');
console.log('pattern', pattern);
console.log('match', normalized.match(pattern));
