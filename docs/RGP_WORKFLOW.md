# RGP (Returnable Gate Pass) Workflow Documentation

This document provides a comprehensive explanation of the Returnable Gate Pass (RGP) workflow within the GatePass system. It is designed to be understood by both technical and non-technical users.

---

## 1. Overview (Non-Technical)

### What is RGP?
RGP stands for **Returnable Gate Pass**. It is a formal document and digital workflow used to authorize the movement of materials out of a company location that are **intended to be returned** after a certain period.

### Why is it used?
RGP is used to track assets that leave the premises temporarily. The system ensures that what goes out must come back. Examples include:
- Tools or machinery sent for repair or calibration.
- Demo units sent to a client.
- Sub-contracted parts for processing.
- Rented equipment being returned.

### Real-World Example
Imagine a factory sends a specialized motor to a vendor for repair. A user creates an RGP for "1 Motor". The system tracks it through the vendor's receipt and then monitors it until the repaired motor is brought back and verified at the factory gate.

---

## 2. End-to-End Workflow (The "Story")

The RGP process is a complete loop, moving through two main phases: **Forward Flow** and **Return Flow**.

### Phase 1: Forward Flow (Sending Out)
1.  **Creation**: A **User** (Requester) initiates an RGP, specifies the items, and adds an **Expected Return Date**.
2.  **Manager Approval**: The manager reviews and approves the temporary movement.
3.  **Origin Security (Dispatch)**: Security at the source gate verifies the motor, records the vehicle number, and allows it to exit.
4.  **Destination Security (Receipt)**: Security at the destination gate (or the vendor site) records the arrival.
5.  **Receiver Confirmation**: The person receiving the items confirms they have physically arrived and are in good condition.

### Phase 2: Return Flow (Coming Back)
6.  **Return Initiation**: When the work is done, the **Receiver** (or originator) clicks "Initiate Return" in the system. They can also add "Additional Items" if the return package has changed.
7.  **Return Manager Approval**: The manager reviews the return request to ensure it's valid.
8.  **Return Dispatch (Destination)**: Security at the *destination* site verifies the motor is being sent back and marks it as "Return Dispatched".
9.  **Return Receipt (Origin)**: The motor arrives back at the *original factory gate*. Security verifies it and marks it as "Return Received".
10. **Final Confirmation**: The **Original Requester** (User) does the final check to ensure their motor is back and functional. Once they click "Confirm", the RGP is marked as **COMPLETED**.

---

## 3. Roles & Responsibilities

| Role | Responsibility | Platform |
| :--- | :--- | :--- |
| **User (Requester)** | Starts the pass, sets return date, and performs final verification. | Dashboard |
| **Manager** | Approves BOTH the initial exit and the eventual return initiation. | Dashboard / Email |
| **Security (SG1)** | Dispatches the item (Forward) and Receives it (Return). | Dashboard / Email |
| **Security (SG2)** | Receives the item (Forward) and Dispatches it (Return). | Dashboard / Email |
| **Receiver** | Confirms initial arrival and initiates the return process. | Dashboard / Email |

---

## 4. Database Structure (Technical)

The RGP flow utilizes more columns in the `material_gate_passes` table than the NRGP flow:

- `pass_type`: Set to `'RGP'`.
- `expected_return_date`: Stores when the item is due back (Mandatory for RGP).
- `receiver_accepted_at`: Timestamp when the destination receiver first got the items.
- `return_initiated_at`: Timestamp when the return journey started.
- `return_confirmed_at`: Final timestamp closing the loop.
- `status`: Transitions through 11 different states during the full cycle.

---

## 5. API / Backend Flow

The logic in `material.controller.js` for RGP is specialized:

1.  **Forward Flow Initialization**: Same as NRGP, but validates that `expected_return_date` is provided.
2.  **State Retention**: After the receiver confirms receipt, the pass status is updated to `PENDING_RECEIVER_CONFIRMATION` (with an internal flag set), allowing the "Initiate Return" button to appear.
3.  **Return Initiation Form**: `getReturnInitiationForm` serves an interactive HTML form to the user to capture any additional items or remarks for the trip back.
4.  **Transaction Safety**: All status updates use `FOR UPDATE` locks to ensure a pass cannot be simultaneously dispatched and received in a race condition.

---

## 6. Email Workflow

RGP triggers more emails than NRGP:
- **Manager Approval Email** (Forward)
- **Security Dispatch Alert** (Forward)
- **Receiver Confirmation Email** (Receipt)
- **Manager Approval Email** (Return)
- **Return Dispatch Alert** (Security SG2)
- **Return Received Alert** (Security SG1)
- **Final Return Receipt Confirmation** (To original User)

Every email uses **Action Tokens** to keep the process fast and mobile-friendly.

---

## 7. Status Flow (11 Stages)

1.  **PENDING_MANAGER**: Waiting for exit approval.
2.  **PENDING_SECURITY_ORIGIN**: Ready for exit dispatch.
3.  **PENDING_SECURITY_DESTINATION**: In transit to destination.
4.  **PENDING_RECEIVER_CONFIRMATION**: Arrived at destination; waiting for receiver to confirm.
5.  **PENDING_RETURN_MANAGER**: Return initiated; waiting for manager approval to come back.
6.  **PENDING_RETURN_SECURITY_DESTINATION**: Approved return; ready to exit destination site.
7.  **PENDING_RETURN_SECURITY_ORIGIN**: In transit back to the factory.
8.  **PENDING_RETURN_RECEIPT**: Arrived at the factory gate; waiting for creator to confirm.
9.  **COMPLETED**: Loop closed.

---

## 8. Error Handling & Edge Cases

- **Late Returns**: The system monitors `expected_return_date` (can be used for automated alerts).
- **Incomplete Returns**: Requesters can "Reject" a return receipt if the item is damaged or parts are missing, forcing a remark.
- **Location Guarding**: Security SG1 (Origin) cannot approve a dispatch from the destination, ensuring data integrity.

---

## 9. Technical Implementation (Coding Details)

### A. Return Initiation Logic
RGP introduces the "Additional Return Items" feature:
```javascript
// material.controller.js
if (additional_items && additional_items.length > 0) {
    const returnItems = additional_items.map(item => [
        passId, item.part_no, item.description, item.qty, 1 // is_return_extra = 1
    ]);
    await connection.query(
        'INSERT INTO material_items (material_pass_id, part_no, description, qty, is_return_extra) VALUES ?',
        [returnItems]
    );
}
```

### B. Closing the Loop
```javascript
// Function: confirmReturnReceipt
const nextStatus = isReject ? 'REJECTED' : 'COMPLETED';
await connection.query(
    `UPDATE material_gate_passes 
     SET status = ?, return_confirmed_at = NOW(), completed_at = NOW() 
     WHERE id = ?`,
    [nextStatus, passId]
);
```

---

## 10. Final Summary (Non-Technical)
RGP is a **Round-Trip Ticket** for materials. 
**Factory → Vendor → Factory.**
The system acts as a digital watchdog, ensuring that items sent out temporarily never get lost and are returned correctly to the original owner.
