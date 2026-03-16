require('ts-node/register');
const { classifyArticle } = require('./worker/src/lib/classify');

const title = 'Iran live updates: Dubai airport resumes some flights after drone impact sparks fuel tank fire';
const body = `Flights to Dubai were suspended after a drone strike near the airport caused a fire. Emirates said in a notice to passengers, "Please do not go to the airport." This is the latest development in a challenging two weeks for Dubai's air travel.`;

console.log(JSON.stringify(classifyArticle(title, body), null, 2));
