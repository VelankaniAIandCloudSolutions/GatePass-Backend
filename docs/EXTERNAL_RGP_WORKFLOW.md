# External RGP (Returnable Gate Pass) Workflow Documentation

This document providing a comprehensive explanation of the **External Returnable Gate Pass (External RGP)** workflow. This specialized lifecycle is designed for materials sent to external parties (vendors, clients, etc.) that do not belong to the internal system locations but are expected to be returned.

---

## 1. Overview (Non-Technical)

### What is External RGP?
An **External RGP** is used when materials leave the factory for an external destination (e.g., a service center in the city) and will later return. Unlike internal RGP, the destination does not have a "Gate Security" or "System Receiver" to confirm arrival.

### Why is it used?
It is used to track assets sent outside the organization's controlled environment where the return process is managed entirely by the **Origin Security** and the **Creator**.
- Machinery sent for off-site repair.
- Equipment sent for third-party calibration.
- Demo units sent to external client offices.

### Real-World Example
A company sends a laptop for repair to a local service center. Since the service center isn't part of our system, we use **External RGP**. The security guard at our factory gate dispatches it. When the laptop comes back, the **same** security guard verifies it and returns it to the owner, who then closes the pass.

---

## 2. End-to-End Workflow (Step-by-Step)

The External RGP workflow is a strict 4-step process:

1.  **Creation**: The **User** selects "External" movement and "RGP" pass type. They enter the **External Address** and **Expected Return Date**.
2.  **Manager Approval**: The **Manager** approves the temporary exit of the material.
3.  **Security Dispatch (SG1)**: Origin Security verifies items and enters **Driver Name**, **Phone**, and **Vehicle Number**. The status moves to **PENDING_RETURN_SG**.
4.  **Security Return Receipt (SG1)**: When materials return, the **SAME Security Officer** who dispatched them must verify and record the return details (**Return Vehicle**, **Return Driver**). The status moves to **PENDING_CREATOR_CONFIRMATION**.
5.  **Creator Final Confirmation**: The **Creator** performs a final check. They can **Confirm** (Status: **COMPLETED**) or **Reject** (returns it to SG1 for correction).

---

## 3. Roles & Responsibilities

| Role | Responsibility | Platform |
| :--- | :--- | :--- |
| **User (Creator)** | Initiates pass, provides external address, and performs final receipt confirmation. | Dashboard |
| **Manager** | Authorizes the initial outward movement. | Dashboard / Email |
| **Security (SG1)** | **Dispatch**: Captures outward vehicle/driver info. **Return**: Captures return vehicle/driver info. | Dashboard / Email |

> [!IMPORTANT]
> **Same-Person Constraint**: For External RGP, the Security Officer who dispatches the material is the only one authorized to process the return. This ensures maximum accountability for items leaving the system's tracked locations.

---

## 4. Status Flow Summary

1.  **PENDING_MANAGER**: Waiting for authorization.
2.  **PENDING_SECURITY_ORIGIN**: Ready for outward dispatch.
3.  **PENDING_RETURN_SG**: Material is outside; awaiting return at the same gate.
4.  **PENDING_CREATOR_CONFIRMATION**: Returned to gate; awaiting creator's final verification.
5.  **COMPLETED**: Loop closed and finalized.

---

## 5. Database Structure (Technical)

The following fields in `material_gate_passes` are critical for this flow:
- `movement_type`: `'external'`
- `dispatched_by`: Stores the ID of the SG who dispatched (used for safety checks).
- `return_vehicle_number`, `return_driver_name`: Captures data during the return phase.
- `status`: Transitions through `PENDING_RETURN_SG` and `PENDING_CREATOR_CONFIRMATION`.

---

## 6. API / Backend Flow

The logic is primarily handled in `material.controller.js`:

1.  **Dispatch**: `markExternalSG1CompleteInternal` 
    - Captures `dispatch_driver_name`, `dispatch_vehicle`, etc.
    - Sets status to `PENDING_RETURN_SG`.
2.  **Return Receipt**: `markExternalRGPReturnConfirmedInternal`
    - Verifies `securityUser.id === pass.dispatched_by`.
    - Captures `return_vehicle_number` and `return_driver_name`.
    - Sets status to `PENDING_CREATOR_CONFIRMATION`.
3.  **Final Confirm**: `confirmReturnReceipt` (Standard RGP function)
    - Sets final status to `COMPLETED`.

---

## 7. Error Handling & Security Guards

- **Identity Lock**: If a different Security Officer attempts to receive an External RGP return, the system displays: *"Action Locked: Only the officer who dispatched this (ID: X) can receive the return."*
- **Final Rejection**: If the Creator rejects the return confirmation, the pass reverts to `PENDING_RETURN_SG`, forcing Security to re-verify the items on the dashboard.

---

## 8. Technical Implementation (Code Snippets)

### Same-SG Verification Logic
```javascript
// Verification in markExternalRGPReturnConfirmedInternal
if (parseInt(pass.dispatched_by) !== parseInt(securityUser.id)) {
    throw new Error(`Only the officer who dispatched this (ID: ${pass.dispatched_by}) can receive the return.`);
}
```

### PDF & Tracking Labels
The system dynamically updates the labels for External RGP:
- **Tracking**: Shows "Dispatch Veh" and "Return Veh" separately.
- **PDF**: Displays "Forward Journey Completed" and "RETURN INITIATOR (SG1 ORIGIN)" with the specific location name.

---

## 9. Final Summary (Non-Technical)
External RGP is a **Closed-Loop External Journey**. 
**User → Manager → SG1 (Out) → Same SG1 (In) → User.**
It is the most secure way to track high-value items sent to third-party vendors, as it locks the responsibility to the same gate officer who saw the items leave.
