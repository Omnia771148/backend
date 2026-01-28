const express = require('express');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Initialize Firebase Admin
// You must put your serviceAccountKey.json in this same folder
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized");
} catch (error) {
    console.error("Error initializing Firebase Admin: Missing serviceAccountKey.json?", error.message);
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

            const targetRestaurantId = newOrder.restId; // Ensure this field exists in Order

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

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);
    startOrderListener();
});
