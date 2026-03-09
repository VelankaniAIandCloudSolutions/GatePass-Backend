CREATE DATABASE IF NOT EXISTS gatepass_db;
USE gatepass_db;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('user', 'manager', 'security') NOT NULL,
    location ENUM('dispatch', 'receiving') NULL,
    status ENUM('pending', 'active') DEFAULT 'pending',
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Email OTPs Table
CREATE TABLE IF NOT EXISTS email_otps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    otp_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    purpose ENUM('signup', 'forgot') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Locations Table
CREATE TABLE IF NOT EXISTS locations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    location_name VARCHAR(255) NOT NULL,
    address_text TEXT NOT NULL,
    contact_person VARCHAR(255),
    phone VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Material Gate Passes Table
CREATE TABLE IF NOT EXISTS material_gate_passes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dc_number VARCHAR(50) NOT NULL UNIQUE,
    created_by INT NOT NULL,
    movement_type ENUM('internal', 'external') NOT NULL,
    from_location_id INT NOT NULL,
    to_location_id INT NULL,
    external_address TEXT NULL,
    manager_id INT NULL,
    status ENUM(
        'pending_manager',
        'approved',
        'dispatched',
        'received',
        'closed',
        'rejected'
    ) DEFAULT 'pending_manager',
    
    approved_by_manager_id INT NULL,
    dispatched_by INT NULL,
    received_by INT NULL,
    
    approved_at TIMESTAMP NULL,
    dispatched_at TIMESTAMP NULL,
    received_at TIMESTAMP NULL,
    closed_at TIMESTAMP NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (from_location_id) REFERENCES locations(id),
    FOREIGN KEY (to_location_id) REFERENCES locations(id),
    FOREIGN KEY (approved_by_manager_id) REFERENCES users(id),
    FOREIGN KEY (dispatched_by) REFERENCES users(id),
    FOREIGN KEY (received_by) REFERENCES users(id)
);

-- 4. Material Items Table
CREATE TABLE IF NOT EXISTS material_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    material_pass_id INT NOT NULL,
    part_no VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    qty INT NOT NULL,
    unit_cost DECIMAL(10, 2) NOT NULL,
    total DECIMAL(12, 2) NOT NULL,
    remarks TEXT,
    FOREIGN KEY (material_pass_id) REFERENCES material_gate_passes(id) ON DELETE CASCADE
);

-- 5. Saved Addresses Table
CREATE TABLE IF NOT EXISTS saved_addresses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    created_by INT NOT NULL,
    label_name VARCHAR(100) NULL,
    address_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
);
