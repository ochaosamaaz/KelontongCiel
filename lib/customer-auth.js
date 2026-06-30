/**
 * Customer Authentication Module
 * Handles customer registration, login, profile, order history, and reseller management.
 * Data stored in customers.json (file-based, same pattern as other data files).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { writeFileAtomic } from './foundation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const CUSTOMERS_FILE = path.join(projectRoot, 'customers.json');

// Ensure customers.json exists
if (!fs.existsSync(CUSTOMERS_FILE)) {
    fs.writeFileSync(CUSTOMERS_FILE, '[]');
}

// ==========================================
// HELPERS
// ==========================================

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateId() {
    return 'cust_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

function loadCustomers() {
    try {
        return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveCustomers(customers) {
    writeFileAtomic(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

// ==========================================
// CORE FUNCTIONS
// ==========================================

/**
 * Register a new customer
 * @param {object} data - { name, email, phone, password }
 * @returns {{ success: boolean, customer?: object, error?: string }}
 */
function registerCustomer({ name, email, phone, password }) {
    if (!name || !email || !phone || !password) {
        return { success: false, error: 'Semua field wajib diisi (nama, email, telepon, password)' };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return { success: false, error: 'Format email tidak valid' };
    }

    // Validate password length
    if (password.length < 6) {
        return { success: false, error: 'Password minimal 6 karakter' };
    }

    // Normalize phone
    let normalizedPhone = phone.replace(/[^0-9]/g, '');
    if (normalizedPhone.startsWith('08')) {
        normalizedPhone = '62' + normalizedPhone.slice(1);
    }

    const customers = loadCustomers();

    // Check if email already registered
    const existingEmail = customers.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (existingEmail) {
        return { success: false, error: 'Email sudah terdaftar. Silakan login.' };
    }

    // Create customer
    const customer = {
        id: generateId(),
        name: name.trim(),
        email: email.toLowerCase().trim(),
        phone: normalizedPhone,
        password: hashPassword(password),
        isReseller: false,
        resellerDiscount: 0, // percentage discount for resellers
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    customers.push(customer);
    saveCustomers(customers);

    // Return without password
    const { password: _, ...safeCustomer } = customer;
    return { success: true, customer: safeCustomer };
}

/**
 * Login a customer
 * @param {string} email
 * @param {string} password
 * @returns {{ success: boolean, customer?: object, error?: string }}
 */
function loginCustomer(email, password) {
    if (!email || !password) {
        return { success: false, error: 'Email dan password wajib diisi' };
    }

    const customers = loadCustomers();
    const customer = customers.find(c => c.email.toLowerCase() === email.toLowerCase());

    if (!customer) {
        return { success: false, error: 'Email tidak ditemukan' };
    }

    if (customer.password !== hashPassword(password)) {
        return { success: false, error: 'Password salah' };
    }

    // Return without password hash
    const { password: _, ...safeCustomer } = customer;
    return { success: true, customer: safeCustomer };
}

/**
 * Get customer by ID
 * @param {string} customerId
 * @returns {object|null}
 */
function getCustomer(customerId) {
    if (!customerId) return null;
    const customers = loadCustomers();
    const customer = customers.find(c => c.id === customerId);
    if (!customer) return null;
    const { password, ...safeCustomer } = customer;
    return safeCustomer;
}

/**
 * Get customer orders from all transaction sources
 * @param {string} customerId
 * @returns {Array}
 */
function getCustomerOrders(customerId) {
    if (!customerId) return [];

    const orders = [];

    // Check web_transactions.json
    try {
        const webTxFile = path.join(projectRoot, 'web_transactions.json');
        if (fs.existsSync(webTxFile)) {
            const webTxs = JSON.parse(fs.readFileSync(webTxFile, 'utf8'));
            webTxs.forEach(tx => {
                if (tx.customerId === customerId) {
                    orders.push({
                        id: tx.id,
                        productName: tx.productName,
                        quantity: tx.quantity,
                        totalPrice: tx.totalPrice || tx.payAmount,
                        status: tx.status,
                        createdAt: tx.createdAt,
                        paidAt: tx.paidAt,
                        source: 'web',
                    });
                }
            });
        }
    } catch (e) { /* ignore */ }

    // Sort by date (newest first)
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return orders;
}

/**
 * Set reseller status for a customer
 * @param {string} customerId
 * @param {boolean} isReseller
 * @param {number} discount - percentage discount (0-100)
 * @returns {{ success: boolean, error?: string }}
 */
function setResellerStatus(customerId, isReseller, discount = 10) {
    const customers = loadCustomers();
    const idx = customers.findIndex(c => c.id === customerId);

    if (idx === -1) {
        return { success: false, error: 'Customer tidak ditemukan' };
    }

    customers[idx].isReseller = !!isReseller;
    customers[idx].resellerDiscount = Math.max(0, Math.min(100, parseInt(discount) || 10));
    customers[idx].updatedAt = Date.now();
    saveCustomers(customers);

    return { success: true, customer: { ...customers[idx], password: undefined } };
}

/**
 * Get all customers (for admin panel)
 * @returns {Array}
 */
function getAllCustomers() {
    const customers = loadCustomers();
    return customers.map(({ password, ...c }) => c);
}

/**
 * Calculate reseller price
 * @param {number} originalPrice
 * @param {object} customer - customer object with isReseller and resellerDiscount
 * @returns {number}
 */
function getResellerPrice(originalPrice, customer) {
    if (!customer || !customer.isReseller) return originalPrice;
    const discount = customer.resellerDiscount || 10;
    return Math.floor(originalPrice * (1 - discount / 100));
}

export {
    registerCustomer,
    loginCustomer,
    getCustomer,
    getCustomerOrders,
    setResellerStatus,
    getAllCustomers,
    getResellerPrice,
    loadCustomers,
};
