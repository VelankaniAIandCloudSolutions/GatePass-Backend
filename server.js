const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { sendResponse } = require('./src/middleware/auth.middleware');

// Load environment variables
dotenv.config();

const app = express();

// Middlewares
app.use(express.json());

// CORS Configuration
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:8000',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Routes
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/material', require('./src/routes/material.routes'));
app.use('/api/locations', require('./src/routes/location.routes'));
app.use('/api/user', require('./src/routes/user.routes'));
app.use('/uploads', express.static('uploads'));

// Root endpoint
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to Gate Pass System API v4.0' });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    sendResponse(res, 500, false, 'Something went wrong!', { error: err.message });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
