const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// Initialize Firebase Admin (uses serviceAccountKey or Application Default Credentials)
const projectId = process.env.FIREBASE_PROJECT_ID || 'edge-light-24';
const collectionName = process.env.FIRESTORE_COLLECTION || 'licenses';

if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: projectId
    });
    console.log('[Firebase] Admin initialized with Service Account.');
  } catch (e) {
    admin.initializeApp({ projectId: projectId });
  }
} else {
  admin.initializeApp({ projectId: projectId });
  console.log('[Firebase] Admin initialized with Project ID:', projectId);
}

const db = admin.firestore();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// Serve Admin Dashboard
app.use('/admin', express.static(path.join(__dirname, 'admin-dashboard')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), project: projectId });
});

// 1. Verify Device License
app.get('/api/licenses/verify/:hwid', async (req, res) => {
  try {
    const { hwid } = req.params;
    if (!hwid) return res.status(400).json({ error: 'Missing hwid' });

    const docRef = db.collection(collectionName).doc(hwid);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ exists: false, status: 'unregistered' });
    }

    const data = snap.data();
    return res.json({ exists: true, ...data });
  } catch (err) {
    console.error('[Verify Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Register Device on First Start
app.post('/api/licenses/register', async (req, res) => {
  try {
    const { hwid, fullHwid, pcName, appVersion } = req.body;
    if (!hwid) return res.status(400).json({ error: 'Missing hwid' });

    const docRef = db.collection(collectionName).doc(hwid);
    const snap = await docRef.get();

    if (snap.exists) {
      // Update heartbeat
      await docRef.update({
        lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        pcName: pcName || snap.data().pcName,
        appVersion: appVersion || snap.data().appVersion
      });
      return res.json({ registered: true, status: snap.data().status });
    }

    const newDoc = {
      hwid,
      fullHwid: fullHwid || '',
      pcName: pcName || 'Unknown Device',
      status: 'trial',
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
      appVersion: appVersion || '1.0.3'
    };

    await docRef.set(newDoc);
    return res.json({ registered: true, status: 'trial' });
  } catch (err) {
    console.error('[Register Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Razorpay Payment Config
app.get('/api/payment/config', (req, res) => {
  res.json({
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_live_TbF2T3PxIu4EAn',
    currency: 'INR',
    plans: {
      monthly: { id: 'monthly', name: 'Monthly Pass', price: 29 },
      quarterly: { id: 'quarterly', name: '3-Month Pass', price: 49 },
      lifetime: { id: 'lifetime', name: 'Lifetime Pro', price: 99 }
    }
  });
});

// 4. Create Razorpay Order
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount, planId, hwid } = req.body;
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TbF2T3PxIu4EAn';
    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'REDACTED_RAZORPAY_SECRET';

    const orderAmount = (parseInt(amount, 10) || 49) * 100; // in paise
    const receipt = `rcpt_${(hwid || 'dev').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}_${Date.now().toString().slice(-6)}`;

    const orderPayload = JSON.stringify({
      amount: orderAmount,
      currency: 'INR',
      receipt: receipt,
      notes: {
        hwid: hwid || 'UNSPECIFIED',
        plan: planId || 'quarterly'
      }
    });

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const options = {
      hostname: 'api.razorpay.com',
      port: 443,
      path: '/v1/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(orderPayload)
      }
    };

    const rzpReq = https.request(options, (rzpRes) => {
      let body = '';
      rzpRes.on('data', chunk => body += chunk);
      rzpRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (rzpRes.statusCode >= 200 && rzpRes.statusCode < 300) {
            res.json({
              success: true,
              orderId: parsed.id,
              amount: parsed.amount,
              currency: parsed.currency,
              keyId: keyId
            });
          } else {
            console.error('[Razorpay Order Error]', parsed);
            res.status(rzpRes.statusCode).json({ error: parsed.error?.description || 'Failed to create order' });
          }
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse Razorpay response' });
        }
      });
    });

    rzpReq.on('error', (e) => {
      console.error('[Razorpay Request Error]', e);
      res.status(500).json({ error: e.message });
    });

    rzpReq.write(orderPayload);
    rzpReq.end();
  } catch (err) {
    console.error('[Create Order Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. Verify Razorpay Payment Signature and Auto-Activate
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, hwid, planId } = req.body;
    const keySecret = process.env.RAZORPAY_KEY_SECRET || 'REDACTED_RAZORPAY_SECRET';

    const hmac = crypto.createHmac('sha256', keySecret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }

    if (hwid) {
      const docRef = db.collection(collectionName).doc(hwid);
      await docRef.set({
        status: 'approved',
        planId: planId || 'pro',
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`[License Approved] HWID ${hwid} approved via verified checkout ${razorpay_payment_id}`);
    }

    res.json({ success: true, status: 'approved' });
  } catch (err) {
    console.error('[Verify Payment Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. Razorpay Payment Webhook Handler (Auto-approves license upon payment)
app.post('/api/webhooks/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (secret && signature) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    const event = req.body.event;
    const payload = req.body.payload;

    console.log(`[Razorpay Webhook] Received event: ${event}`);

    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = payload.payment ? payload.payment.entity : null;
      const notes = payment?.notes || {};
      const hwid = notes.hwid || notes.HWID;

      if (hwid) {
        const docRef = db.collection(collectionName).doc(hwid);
        await docRef.set({
          status: 'approved',
          planId: notes.plan || 'pro',
          amount: payment.amount ? payment.amount / 100 : 49,
          paymentId: payment.id,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`[License Approved] HWID ${hwid} approved via Razorpay payment ${payment.id}`);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ Edge Light Backend server running on port ${PORT}`);
  console.log(`📊 Admin Console available at: http://localhost:${PORT}/admin`);
});
