/*
  Simple push notification server.
  Usage:
    npm install web-push express body-parser
    VAPID_PUBLIC_KEY=<your pub key> VAPID_PRIVATE_KEY=<your priv key> node scripts/push-server.js

  - POST /api/subscribe with the subscription object from the client
  - POST /api/sendNotification with {title,body,url} to broadcast to all subscribers
*/

const express = require('express');
const bodyParser = require('body-parser');
const webpush = require('web-push');

const app = express();
app.use(bodyParser.json());

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '<YOUR_PUBLIC_KEY>',
  privateKey: process.env.VAPID_PRIVATE_KEY || '<YOUR_PRIVATE_KEY>',
};

webpush.setVapidDetails(
  'mailto:admin@yourdomain.org',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

const subscriptions = [];

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!subscriptions.find((s) => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
  }
  res.status(201).json({ success: true });
});

app.post('/api/sendNotification', async (req, res) => {
  const { title = 'New article', body = '', url = '/' } = req.body;
  const payload = JSON.stringify({ title, body, url });

  try {
    await Promise.all(
      subscriptions.map((sub) => webpush.sendNotification(sub, payload)),
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error sending notification', err);
    res.status(500).json({ error: 'failed to send' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Push server listening on ${PORT}`);
  console.log(`VAPID public key: ${vapidKeys.publicKey}`);
});