const bcrypt = require('bcryptjs');

const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const hashOTP = async (otp) => {
    return await bcrypt.hash(otp, 10);
};

const verifyOTP = async (otp, hashedOtp) => {
    return await bcrypt.compare(otp, hashedOtp);
};

module.exports = { generateOTP, hashOTP, verifyOTP };
