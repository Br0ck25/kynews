const re = /['\"](https?:\/\/[^'\"\)\s,]+)['\"]/g;
const s = "'https://abcnews.go.com/abcnews/topstories?format=rss',";
console.log('match', re.exec(s));
