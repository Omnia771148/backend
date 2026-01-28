const express = require('express');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Initialize Firebase Admin
try {
    let serviceAccount;

    // Try to read from environment variable first (for production/Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        // Fall back to local file (for development)
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized");
} catch (error) {
    console.error("Error initializing Firebase Admin:", error.message);
}

// 2. Connect to MongoDB
const MONGO_URI = 'mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/';

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Connection Error:', err));

// 3. Define Schemas (Just enough to read the data)
// Restaurant Schema
const RestaurantSchema = new mongoose.Schema({
    // Adjust these field names to match your actual database!
    email: String,
    restId: String, // CHANGED from restaurantId to restId
    password: String,
    fcmToken: String
}, { collection: 'restuarentusers', strict: false });

const Restaurant = mongoose.model('Restaurant', RestaurantSchema);

// Order Schema
const OrderSchema = new mongoose.Schema({
    // Adjust field names
    restaurantId: String,
    status: String,
    items: Array
}, { collection: 'orders', strict: false });

const Order = mongoose.model('Order', OrderSchema);

// 3.5 Root Route
app.get('/', (req, res) => {
    res.json({ message: 'Backend Server is running! 🚀', status: 'OK' });
});

// 8. Fetch Orders API
app.get('/api/orders', async (req, res) => {
    try {
        const { restId } = req.query;

        if (!restId) {
            return res.status(400).json({ success: false, message: 'Restaurant ID required' });
        }

        // Fetch orders for this restaurant, sorted by newest first
        const orders = await Order.find({ restaurantId: restId }).sort({ _id: -1 }).limit(50);

        res.json({ success: true, orders });
    } catch (error) {
        console.error('Fetch Orders Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// 4. API to Save FCM Token (Called by Restaurant App on Login/Startup)
app.post('/update-fcm', async (req, res) => {
    const { restId, fcmToken } = req.body; // Expect restId from frontend

    if (!restId || !fcmToken) {
        return res.status(400).json({ error: 'Missing restId or fcmToken' });
    }

    try {
        // Update the token for this restaurant
        const result = await Restaurant.findOneAndUpdate(
            { restId: restId }, // Query by restId
            { $set: { fcmToken: fcmToken } }, // Update
            { new: true, upsert: true } // Options
        );
        console.log(`Updated Token for Restaurant ${restId}`);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error("Error updating token:", error);
        res.status(500).json({ error: error.message });
    }
});

// 5. CHANGE STREAM: Listen for New Orders
// This runs continuously
const startOrderListener = () => {
    const orderStream = Order.watch();

    orderStream.on('change', async (change) => {
        // We only care about 'insert' (new orders)
        if (change.operationType === 'insert') {
            const newOrder = change.fullDocument;
            console.log("🔥 NEW ORDER DETECTED:", newOrder._id);

            const targetRestaurantId = newOrder.restaurantId; // Read 'restaurantId' from Order collection

            if (targetRestaurantId) {
                // Find the restaurant to get the FCM token
                const restaurant = await Restaurant.findOne({ restId: targetRestaurantId });

                if (restaurant && restaurant.fcmToken) {
                    console.log(`Found Restaurant: ${restaurant.email}, Sending Notification...`);
                    sendNotification(restaurant.fcmToken, newOrder);
                } else {
                    console.log(`No FCM Token found for Restaurant (restId: ${targetRestaurantId})`);
                }
            }
        }
    });

    console.log("✅ Listening for new orders in MongoDB...");
};

// 6. Helper to Send Notification
async function sendNotification(token, order) {
    const message = {
        token: token,
        notification: {
            title: 'New Order Received! 🍔',
            body: `Order #${order._id.toString().slice(-4)} has been placed.`,
        },
        data: {
            orderId: order._id.toString(),
            action: 'open_order'
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'default',
                sound: 'default'
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('Successfully sent message:', response);
    } catch (error) {
        console.log('Error sending message:', error);
    }
}

// Accepted Order Schema
const AcceptedOrderSchema = new mongoose.Schema({
    restaurantId: String,
    status: String,
    items: Array,
    acceptedAt: { type: Date, default: Date.now },
    originalOrderId: String,
    // Include all other fields you need
}, { collection: 'acceptedorders', strict: false });

const AcceptedOrder = mongoose.model('AcceptedOrder', AcceptedOrderSchema);

// Order Status Schema (for tracking status like 'waiting for deliveryboy')
const OrderStatusSchema = new mongoose.Schema({
    orderId: String,
    status: String,
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'orderstatuses', strict: false });

const OrderStatus = mongoose.model('OrderStatus', OrderStatusSchema);

// 9. Accept Order API
app.post('/api/orders/accept', async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ success: false, message: 'Order ID required' });
        }

        // 1. Find the order in 'orders' collection
        const originalOrder = await Order.findById(orderId);
        if (!originalOrder) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // 2. Save to 'acceptedorders' collection
        const newAcceptedOrder = new AcceptedOrder({
            ...originalOrder.toObject(),
            _id: new mongoose.Types.ObjectId(), // New ID
            originalOrderId: originalOrder._id,
            status: 'Accepted'
        });
        await newAcceptedOrder.save();

        // 3. Update status in 'orderstatuses' collection
        // Just update existing document. Do NOT create new one.
        await OrderStatus.findOneAndUpdate(
            { orderId: orderId },
            { $set: { status: 'waiting for deliveryboy', updatedAt: new Date() } }
        );

        // 4. DELETE from 'orders' collection
        await Order.findByIdAndDelete(orderId);

        console.log(`Order ${orderId} Accepted: Moved to acceptedorders, Status updated, Deleted from orders.`);
        res.json({ success: true, message: 'Order accepted processed successfully' });

    } catch (error) {
        console.error('Accept Order Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// 7. Login API
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password required' });
        }

        // Find user by email and password in 'restuarentusers' collection
        // Note: In production, you really should Hash passwords! (e.g. bcrypt)
        // But we will stick to your current logic for now.
        const user = await Restaurant.findOne({ email: email, password: password });

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid email or password' });
        }

        // Return the user data
        res.json({
            success: true,
            user: {
                restId: user.restId,
                restLocation: user.restLocation,
                email: user.email,
                phone: user.phone,
                _id: user._id
            }
        });

    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
    startOrderListener();
});
