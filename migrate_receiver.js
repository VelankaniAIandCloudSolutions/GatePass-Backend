const pool = require('./src/config/db.config');

(async () => {
    try {
        console.log('Starting migration...');
        // Add receiver_confirmed_by
        await pool.query('ALTER TABLE material_gate_passes ADD COLUMN receiver_confirmed_by INT NULL AFTER receiver_confirmed_at');
        console.log('Added receiver_confirmed_by column.');
        
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
})();
