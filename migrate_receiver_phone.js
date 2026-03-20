const pool = require('./src/config/db.config');

async function migrate() {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('Connected to database for migration...');

        // Check if receiver_phone exists
        const [columns] = await connection.query('SHOW COLUMNS FROM material_gate_passes LIKE "receiver_phone"');
        
        if (columns.length === 0) {
            console.log('Adding receiver_phone column...');
            await connection.query('ALTER TABLE material_gate_passes ADD COLUMN receiver_phone VARCHAR(20) NULL AFTER receiver_email');
            console.log('receiver_phone column added successfully.');
        } else {
            console.log('receiver_phone column already exists.');
        }

    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        if (connection) connection.release();
        process.exit();
    }
}

migrate();
