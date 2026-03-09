const pool = require('../config/db.config');
const bcrypt = require('bcryptjs');

const seedAdmin = async () => {
    const name = 'Super Admin';
    const email = 'ankithbv007@gmail.com';
    const plainPassword = 'Deepakbv@007';
    const role = 'admin';

    try {
        console.log('⏳ Hashing password...');
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        
        console.log('⏳ Checking if admin already exists...');
        const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        
        if (existing.length > 0) {
            console.log('⚠️  Admin user already exists. Updating password...');
            await pool.query('UPDATE users SET password = ?, name = ?, role = ? WHERE email = ?', [hashedPassword, name, role, email]);
        } else {
            console.log('⏳ Inserting Super Admin...');
            await pool.query(
                'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, TRUE)',
                [name, email, hashedPassword, role]
            );
        }

        console.log('✅ Super Admin Seeded Successfully!');
        console.log(`📧 Email: ${email}`);
        console.log(`🔑 Password: ${plainPassword} (Hashed: ${hashedPassword})`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding Failed:', error.message);
        process.exit(1);
    }
};

seedAdmin();
