# NRGP (Non-Returnable Gate Pass) Workflow Documentation

This document provides a comprehensive explanation of the Non-Returnable Gate Pass (NRGP) workflow within the GatePass system. It is designed to be understood by both technical and non-technical users.

---

## 1. Overview (Non-Technical)

### What is NRGP?
NRGP stands for **Non-Returnable Gate Pass**. It is a formal document and digital workflow used to authorize the movement of materials out of a company location that are **not intended to be returned**.

### Why is it used?
NRGP is used to maintain strict control and a digital audit trail of any company assets or materials leaving the premises permanently. This includes items like:
- Scrapped materials or waste.
- Sold assets (old machinery, furniture).
- Materials sent for permanent disposal.
- Items issued to a client or another site permanently.

### Real-World Example
Imagine a factory is selling 50 old chairs to a scrap dealer. To let the truck carry the chairs out of the gate, a user creates an NRGP. Once authorized by the manager and security, the truck can leave. The dealer confirms they received the chairs, and the record is closed forever.

---

## 2. End-to-End Workflow (Step-Step)

The NRGP process follows a linear "story" from creation to completion:

1.  **Creation**: A **User** (Requester) needs to move materials out permanently. They log into the dashboard, select "NRGP", enter the items (e.g., "100kg Copper Scrap"), and specify where it's going.
2.  **Manager Approval**: Once submitted, the **Manager** receives an email notification. They can click "Approve" directly from the email or log in to the dashboard to review the details.
3.  **Origin Security (Dispatch)**: After manager approval, the gate pass reaches the **Origin Security (SG1)**. They verify the physical materials against the digital pass. If everything matches, they enter the **Vehicle Number** (e.g., "KA-01-AB-1234") and mark it as **Dispatched**.
4.  **Destination Security (Receipt)**: When the material arrives at its destination, the **Destination Security (SG2)** verifies the arrival and marks the pass as **Received** at their gate.
5.  **Receiver Confirmation**: Finally, the **Receiver** (the person or entity at the destination) confirms that they have physically received all the items. Once they click "Confirm", the NRGP status changes to **COMPLETED**.

---

## 3. Roles & Responsibilities

| Role | Responsibility | Platform |
| :--- | :--- | :--- |
| **User (Requester)** | Initiates the request, adds items, and sets the destination. | Dashboard |
| **Manager** | Authorizes the movement. Can "Approve" or "Reject". | Dashboard / Email |
| **Security (SG1)** | Validates materials at exit, records vehicle number. | Dashboard / Email |
| **Security (SG2)** | Validates materials at entry of destination. | Dashboard / Email |
| **Receiver** | Confirms final receipt of goods to close the pass. | Dashboard / Email |

---

## 4. Database Structure (Technical)

The system uses several interconnected tables to track NRGP data:

### `material_gate_passes` (Main Table)
Stores the core details of every gate pass.
- `id`: Unique identifier.
- `dc_number`: Delivery Challan or Pass number.
- `status`: Current stage (e.g., `PENDING_MANAGER`, `COMPLETED`).
- `pass_type`: Set to `'NRGP'`.
- `created_by`: ID of the user who created it.

### `material_items`
Stores the individual products/materials within a pass.
- `pass_id`: Linked to the main pass.
- `description`: Name of the item.
- `qty`: Quantity being moved.

### `tracking_logs` (Audit Trail)
Records every single action taken on a pass.
- `pass_id`: Linked pass.
- `action`: What was done (e.g., `APPROVED`, `DISPATCHED`).
- `from_status` / `to_status`: The status change (e.g., `PENDING_MANAGER` → `PENDING_SECURITY_ORIGIN`).
- `performed_by`: The user who took the action.

### `email_action_tokens`
Stores temporary, secure tokens for actions taken directly from emails.
- `token`: Encrypted/unique string in the email link.
- `used`: Flag (0 or 1) to prevent the same link from being used twice.

---

## 5. API / Backend Flow

The backend logic is centralized in the `material.controller.js` file:

1.  **Request Initiation**: `createMaterialPass` receives the data and saves it to the database with a `PENDING_MANAGER` status.
2.  **Notification Engine**: `mail.util.js` triggers localized emails with secure action links containing unique **Email Action Tokens**.
3.  **Token Processing**: When a user clicks a button in an email, the `handleSecurityTokenAction` or `updateManagerStatus` functions:
    - Validate the token exists and hasn't expired.
    - Check if the token was already used (Idempotency).
    - Update the pass status and log the action in `tracking_logs`.
    - Trigger the next notification in the chain.

---

## 6. Email Workflow & Tokens

### How it Works:
Every approval or rejection link in an email contains a unique `token`.
- **Security**: The token is a long, random string that cannot be guessed.
- **Single Use**: Once clicked and processed successfully, the token is marked as `used = 1` in the database.
- **Convenience**: Users don't need to log in to perform a quick "Approve" or "Reject" action; the token identifies them securely.

---

## 7. Status Flow Summary

1.  **PENDING_MANAGER**: Awaiting manager's nod.
2.  **PENDING_SECURITY_ORIGIN**: Manager approved; awaiting dispatch from the source gate.
3.  **PENDING_SECURITY_DESTINATION**: Dispatched; items are in transit.
4.  **PENDING_RECEIVER_CONFIRMATION**: Items arrived at the destination gate (SG2 confirmed).
5.  **COMPLETED**: Receiver confirmed receipt; the workflow is finished.

---

## 8. Error Handling & Edge Cases

- **Missing Remarks**: If a user tries to "Reject" without a reason (from the dashboard or email), the system shows a **Mandatory Rejection Form**. The action is blocked until a reason is provided.
- **Duplicate Clicks**: If a manager clicks "Approve" twice, the second click shows an "Action Blocked" message because the token is already used.
- **Token Expiry**: All email links have an expiration time (e.g., 24-48 hours). If clicked after that, the user is prompted to log in and take action manually.

---

## 10. Technical Implementation (Coding Details)

For developers, the NRGP workflow is implemented across the following core areas:

### A. Controller Logic (`material.controller.js`)

#### 1. Creation (`createMaterialPass`)
When an NRGP is created, it is initialized with `PENDING_MANAGER` status.
```javascript
// Simplified Logic
const [result] = await connection.query(
    `INSERT INTO material_gate_passes 
    (..., pass_type, status, ...) 
    VALUES (..., ?, 'PENDING_MANAGER', ...)`,
    [..., pass_type || 'NRGP', ...]
);
```

#### 2. Status Transitions
The status transitions are strictly controlled via transaction-based updates:

- **Manager Approval**: `PENDING_MANAGER` → `PENDING_SECURITY_ORIGIN`
- **Security Dispatch**: `PENDING_SECURITY_ORIGIN` → `PENDING_SECURITY_DESTINATION`
- **Security Receipt**: `PENDING_SECURITY_DESTINATION` → `PENDING_RECEIVER_CONFIRMATION`
- **Receiver Confirmation**: `PENDING_RECEIVER_CONFIRMATION` → `COMPLETED`

#### 3. Final Completion (`confirmReceiverPortal`)
For NRGP, the receiver's confirmation is the final step:
```javascript
// material.controller.js
if (pass.pass_type === 'NRGP') {
    nextStatus = 'COMPLETED';
    await connection.query(
        "UPDATE material_gate_passes SET status = ?, completed_at = NOW() WHERE id = ?",
        [nextStatus, passId]
    );
}
```

### B. Database Schema & Relationships

Key tables and their roles in the NRGP flow:

| Table | Role in NRGP |
| :--- | :--- |
| `material_gate_passes` | The central state machine tracking `status`. |
| `tracking_logs` | Captures history for audit transparency. |
| `email_action_tokens` | Manages secure, one-time authentication for email actions. |

### C. Security & Validation
The system enforces strict validation at every stage:
- **Location Matching**: Security can only dispatch/receive if their `location_id` matches the pass's `from_location_id` or `to_location_id`.
- **Mandatory Rejection Reasons**: All rejection endpoints check for a trimmed `rejected_reason`.
- **Token Idempotency**:
```javascript
if (tokenRecord.used) {
    return renderHtmlResponse(false, 'Action Blocked', 'You have already processed this request.');
}
```

---

## 11. Final Summary (Non-Technical)
In short, NRGP is a digital "Chain of Custody" for items leaving permanently. 
**Creator → Manager → Origin Gate → Destination Gate → Receiver.**
Every step is confirmed, every person is identified, and every rejection requires a reason. It turns a manual, paper-based gate process into a secure, trackable, and efficient digital movement.
