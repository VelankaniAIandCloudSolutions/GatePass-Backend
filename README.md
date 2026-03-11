# 🚪 GatePass System - Backend API

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white)

The robust backend engine powering the GatePass System. Built with Node.js and Express, it handles authentication, material pass management, PDF generation, and secure data storage.

## 🚀 Key Features

- **🔐 Secure Authentication**: JWT-based login with hashed passwords (Bcrypt).
- **📋 Material Pass Workflow**: Create, track, and manage material passes (RGP/NRGP).
- **📄 PDF Generation**: Dynamic PDF generation for passes using `html-pdf-node` and `puppeteer`.
- **📧 Email Notifications**: Automated alerts for pass approvals and updates.
- **📂 File Management**: Secure handling of digital signatures and user avatars.
- **🛡️ Security First**: Rate limiting, request validation, and CORS protection.

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js (v5.0)
- **Database**: MySQL (via `mysql2`)
- **Authentication**: JSON Web Tokens & Bcrypt
- **Documentation**: Markdown
- **Validation**: Express Validator

## 📦 Installation & Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory and add the following:
   ```env
   PORT=5000
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=your_password
   DB_NAME=gatepass_db
   JWT_SECRET=your_super_secret_key
   FRONTEND_URL=http://localhost:8000
   ```

4. **Run the application**
   ```bash
   # Development mode (with nodemon)
   npm run dev

   # Production mode
   npm start
   ```

## 🛤️ API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/login` | User authentication |
| `GET` | `/api/material` | Fetch all material passes |
| `POST` | `/api/material/create` | Create a new material pass |
| `GET` | `/api/user/profile` | Get current user details |
| `GET` | `/api/locations` | List available locations |

## 📂 Project Structure

```text
backend/
├── src/
│   ├── config/      # Database & app configurations
│   ├── controllers/ # Business logic
│   ├── routes/      # API entry points
│   ├── middleware/  # Auth & validation guards
│   ├── utils/       # Helpers (OTP, Mail, Tokens)
│   └── services/    # External logic (PDF generation)
├── uploads/         # Static assets (Signatures/Avatars)
└── server.js        # Entry point
```

---
Built with ❤️ by Velankani AI and Cloud Solutions.
