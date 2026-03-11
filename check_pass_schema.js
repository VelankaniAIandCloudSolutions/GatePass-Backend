const pool = require('./src/config/db.config');

(async () => {
    try {
        const [rows] = await pool.query('DESCRIBE material_gate_passes');
        console.log(JSON.stringify(rows, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
