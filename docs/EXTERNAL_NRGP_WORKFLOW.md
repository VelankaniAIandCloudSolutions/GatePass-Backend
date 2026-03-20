# External NRGP (Non-Returnable Gate Pass) Workflow Documentation

This document provides a comprehensive explanation of the **External Non-Returnable Gate Pass (External NRGP)** workflow within the GatePass system. It mirrors the structure of the standard NRGP documentation but highlights the specific logic used for external movements.

---

## 1. Overview (Non-Technical)

### What is External NRGP?
An **External NRGP** is a specialized version of the Non-Returnable Gate Pass used for materials leaving the company premises to an **external destination** (e.g., a customer site, a vendor's workshop, or a scrap yard) that is **not part of the internal system locations**.

### Why is it used?
It is used to authorize and track the permanent removal of materials to parties outside the organization's controlled environment. 
- Sent to a buyer or client permanently.
- Disposal at an external waste management facility.
- Delivery to a third-party partner.

### Real-World Example
A company is donating old laptops to an NGO. Since the NGO is not a "site" in our GatePass system, the user creates an **External NRGP**. They enter the NGO's office address manually. Once the gate security dispatches the van, the pass is closed because the NGO doesn't have our system's "Security Gate" or "Receiver" to confirm arrival.

---

## 2. End-to-End Workflow (Step-Step)

The External NRGP workflow is shorter and more direct than the internal one:

1.  **Creation**: A **User** selects "External" as the movement type and "NRGP" as the pass type. They must manually enter the **Receiver Name** and the **External Address**.
2.  **Manager Approval**: The **Manager** receives a notification. They review the specific external destination and items before approving.
3.  **Origin Security (Dispatch & Completion)**: This is the **most critical difference**. Because the destination is external, the **Origin Security (SG1)** performs the final system action. They enter the **Vehicle Number**, **Driver Name**, and **Driver Phone**. As soon as they mark it as "Complete", the system marks the entire pass as **COMPLETED**.
4.  **Automatic Closure**: There are no further steps for "Destination Security" or "Receiver" in the system, as the material has left the system's tracked orbit.

---

## 3. Roles & Responsibilities

| Role | Responsibility | Platform |
| :--- | :--- | :--- |
| **User (Requester)** | Selects "External", enters receiver name and destination address. | Dashboard |
| **Manager** | Authorizes the external movement. | Dashboard / Email |
| **Security (SG1)** | Validates materials, enters vehicle/driver details, and **closes the pass**. | Dashboard / Email |

---

## 4. Database Structure (Technical)

### `material_gate_passes` (Main Table)
Specific fields for External NRGP:
- `movement_type`: Set to `'external'`.
- `pass_type`: Set to `'NRGP'`.
- `external_address`: Stores the manually entered destination string.
- `receiver_name`: Stores the manually entered recipient name.
- `status`: Transitions directly from `PENDING_SECURITY_ORIGIN` to `COMPLETED`.

---

## 5. API / Backend Flow

The logic is handled in `material.controller.js`:

1.  **Validation**: `createMaterialPass` enforces `receiver_name` for external movements.
2.  **Dispatch Logic**: The helper function `markExternalSG1CompleteInternal` handles the closure:
    - It verifies the movement is indeed `external`.
    - It captures vehicle and driver data.
    - It sets status to `COMPLETED` and `completed_at` to the current time immediately upon dispatch.
3.  **Email Notification**: Triggers `sendExternalNRGPCompletionEmail` to inform the creator that the material has successfully left the premises.

---

## 6. Status Flow Summary

1.  **PENDING_MANAGER**: Awaiting manager's authorization.
2.  **PENDING_SECURITY_ORIGIN**: Approved; awaiting physical dispatch at the gate.
3.  **COMPLETED**: Dispatched by SG1; the workflow finishes here.

---

## 7. Error Handling & Edge Cases

- **Receiver Details**: If "External" is selected, the system blocks submission if the `receiver_name` is empty.
- **Location Guard**: Security personnel can only "Complete" an external pass if their assigned `location_id` matches the `from_location_id` of the pass.
- **Phone Validation**: The system enforces a strict 10-digit format for the driver's phone number during the completion step.

---

## 8. Technical Implementation (Coding Details)

### Completion Trigger
In `material.controller.js`, the completion logic for external passes skips the transit and receipt phases:

```javascript
// Function: markExternalSG1CompleteInternal
const nextStatus = 'COMPLETED';
await connection.query(
    `UPDATE material_gate_passes 
     SET status = ?, 
         dispatched_by = ?, 
         completed_at = NOW(), 
         ... 
     WHERE id = ?`,
    [nextStatus, securityUser.id, ...]
);
```

### Notification Logic
The creator receives a specific "External NRGP Completion" email instead of a standard "Dispatched" email, acknowledging the material's final exit from the system.

---

## 9. Final Summary (Non-Technical)
External NRGP is the digital equivalent of a "One-Way Ticket" out of the company. 
**Creator → Manager → Origin Gate (SG1) → Done.**
It simplifies the process while ensuring that every item leaving for an external vendor is authorized and logged with vehicle/driver information for security and audit purposes.
