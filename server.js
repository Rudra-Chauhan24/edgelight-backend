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

function calculatePlanDetails(planId) {
  const normalized = (planId || 'quarterly').toLowerCase();
  const now = Date.now();
  if (normalized === 'monthly') {
    return {
      planId: 'monthly',
      planName: 'Monthly Pass',
      expiresAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
      licenseKey: `EL-MONTHLY-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    };
  } else if (normalized === 'lifetime') {
    return {
      planId: 'lifetime',
      planName: 'Lifetime Pro',
      expiresAt: null, // Permanent
      licenseKey: `EL-LIFETIME-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    };
  } else {
    // quarterly / 3-month (default)
    return {
      planId: 'quarterly',
      planName: '3-Month Pass',
      expiresAt: new Date(now + 90 * 24 * 3600 * 1000).toISOString(),
      licenseKey: `EL-3MONTH-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    };
  }
}

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

    const planDetails = calculatePlanDetails(planId);

    if (hwid) {
      const docRef = db.collection(collectionName).doc(hwid);
      await docRef.set({
        status: 'approved',
        planId: planDetails.planId,
        planName: planDetails.planName,
        licenseKey: planDetails.licenseKey,
        expiresAt: planDetails.expiresAt,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`[License Approved] HWID ${hwid} assigned ${planDetails.planName} (Key: ${planDetails.licenseKey})`);
    }

    res.json({
      success: true,
      status: 'approved',
      ...planDetails
    });
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
      const planId = notes.plan || notes.planId || 'quarterly';

      if (hwid) {
        const planDetails = calculatePlanDetails(planId);
        const docRef = db.collection(collectionName).doc(hwid);
        await docRef.set({
          status: 'approved',
          planId: planDetails.planId,
          planName: planDetails.planName,
          licenseKey: planDetails.licenseKey,
          expiresAt: planDetails.expiresAt,
          amount: payment.amount ? payment.amount / 100 : 49,
          paymentId: payment.id,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`[License Approved via Webhook] HWID ${hwid} assigned ${planDetails.planName} (Key: ${planDetails.licenseKey})`);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 7. Admin Analytics & Device Counts Endpoint
app.get('/api/admin/stats', async (req, res) => {
  try {
    const snap = await db.collection(collectionName).get();
    const now = Date.now();
    const fifteenMinMs = 15 * 60 * 1000;
    const oneDayMs = 24 * 3600 * 1000;

    let total = 0;
    let onlineNow = 0;
    let activeToday = 0;
    const breakdown = { approved: 0, trial: 0, expired: 0, rejected: 0, revoked: 0 };
    const plans = { lifetime: 0, quarterly: 0, monthly: 0, trial: 0 };

    snap.forEach(doc => {
      total++;
      const data = doc.data();
      const lastActiveMs = data.lastActiveAt ? (data.lastActiveAt.toMillis ? data.lastActiveAt.toMillis() : new Date(data.lastActiveAt).getTime()) : 0;

      if (lastActiveMs > 0 && (now - lastActiveMs < fifteenMinMs)) onlineNow++;
      if (lastActiveMs > 0 && (now - lastActiveMs < oneDayMs)) activeToday++;

      const status = data.status || 'trial';
      breakdown[status] = (breakdown[status] || 0) + 1;

      const planId = data.planId || (status === 'approved' ? 'lifetime' : 'trial');
      plans[planId] = (plans[planId] || 0) + 1;
    });

    res.json({
      success: true,
      total,
      onlineNow,
      activeToday,
      breakdown,
      plans,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Admin Stats Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Device Listing Endpoint for Admin Dashboard
app.get('/api/devices', async (req, res) => {
  try {
    const snap = await db.collection(collectionName).get();
    const list = [];
    snap.forEach(doc => {
      const data = doc.data();
      list.push({
        id: doc.id,
        hwid: doc.id,
        ...data,
        registeredAt: data.registeredAt?.toDate ? data.registeredAt.toDate().toISOString() : data.registeredAt,
        lastActiveAt: data.lastActiveAt?.toDate ? data.lastActiveAt.toDate().toISOString() : data.lastActiveAt,
        approvedAt: data.approvedAt?.toDate ? data.approvedAt.toDate().toISOString() : data.approvedAt
      });
    });
    res.json({ success: true, count: list.length, devices: list });
  } catch (err) {
    console.error('[Get Devices Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 9. Over-The-Air (OTA) Updates Manifest & Publish Endpoints
let currentRelease = {
  version: '1.0.7',
  releaseDate: '2026-09-28T18:00:00.000Z',
  notes: '⚡ Full payment flow & window layering redesign. Fixes z-index conflict and adds seamless browser and popup checkout.',
  downloadUrl: 'https://github.com/Rudra-Chauhan24/edgelight-app/releases/download/v1.0.7/Edge.Light.Setup.1.0.7.exe',
  setupUrl: 'https://github.com/Rudra-Chauhan24/edgelight-app/releases/download/v1.0.7/Edge.Light.Setup.1.0.7.exe'
};

app.get('/api/updates/latest', async (req, res) => {
  try {
    const relDoc = await db.collection('system').doc('latest_release').get();
    if (relDoc.exists) {
      const data = relDoc.data();
      return res.json({
        success: true,
        version: data.version,
        releaseDate: data.releaseDate,
        notes: data.notes,
        downloadUrl: data.downloadUrl || data.setupUrl,
        setupUrl: data.setupUrl || data.downloadUrl
      });
    }
  } catch (e) {}
  res.json({
    success: true,
    ...currentRelease
  });
});

app.post('/api/updates/publish', async (req, res) => {
  try {
    const { version, notes, downloadUrl, setupUrl } = req.body;
    if (!version) return res.status(400).json({ error: 'Missing version' });

    const cleanVer = version.replace(/^v/i, '').trim();
    const newRelease = {
      version: cleanVer,
      releaseDate: new Date().toISOString(),
      notes: notes || '✨ Performance refinements, optical glow tuning, and stability improvements.',
      downloadUrl: downloadUrl || `https://github.com/CHAUHANRUDRA24/edgelight-app/releases/download/v${cleanVer}/Edge.Light.Setup.${cleanVer}.exe`,
      setupUrl: setupUrl || downloadUrl || `https://github.com/CHAUHANRUDRA24/edgelight-app/releases/download/v${cleanVer}/Edge.Light.Setup.${cleanVer}.exe`,
      publishedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    currentRelease = { ...newRelease };
    await db.collection('system').doc('latest_release').set(newRelease, { merge: true });

    console.log(`[OTA Update Published] Version ${cleanVer} published.`);
    res.json({ success: true, release: newRelease });
  } catch (err) {
    console.error('[Publish Update Error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ Edge Light Backend server running on port ${PORT}`);
  console.log(`📊 Admin Console available at: http://localhost:${PORT}/admin`);
});

