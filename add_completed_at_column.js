const pool = require('./src/config/db.config');

async function migrate() {
    const connection = await pool.getConnection();
    try {
        console.log('Starting migration to add completed_at column...');
        await connection.query(`
            ALTER TABLE material_gate_passes 
            ADD COLUMN completed_at DATETIME DEFAULT NULL AFTER updated_at
        `);
        console.log('Success: completed_at column added.');

        // Backfill existing completed/rejected records
        console.log('Backfilling completed_at from return_confirmed_at, security_destination_approved_at, or rejected_at...');
        await connection.query(`
            UPDATE material_gate_passes 
            SET completed_at = COALESCE(return_confirmed_at, receiver_confirmed_at, security_destination_approved_at, rejected_at)
            WHERE status IN ('COMPLETED', 'REJECTED') AND completed_at IS NULL
        `);
        console.log('Backfill complete.');

    } catch (err) {
        if (err.code === 'ER_DUP_COLUMN_NAME') {
            console.log('Column already exists, skipping migration.');
        } else {
            console.error('Migration failed:', err);
        }
    } finally {
        connection.release();
        process.exit();
    }
}

migrate();
