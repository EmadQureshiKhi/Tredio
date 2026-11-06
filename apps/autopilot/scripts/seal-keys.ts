/**
 * Makes a new executor key pair for sealed grants. The private half goes in this service's
 * AUTOPILOT_SEAL_PRIVATE_KEY, the public half in the backend's AUTOPILOT_SEAL_PUBLIC_KEY; grants
 * sealed to an earlier key stop opening, so accounts grant Autopilot again after a rotation.
 *
 *   bun run seal-keys
 */
import { generateSealKeyPair, sealKeyId } from "@tredio/autopilot";

const pair = await generateSealKeyPair();
console.log(`# Autopilot executor (.env), secret:\nAUTOPILOT_SEAL_PRIVATE_KEY=${pair.privateKey}`);
console.log(`# Backend (.env), public:\nAUTOPILOT_SEAL_PUBLIC_KEY=${pair.publicKey}`);
console.log(`# Key id grants name: ${await sealKeyId(pair.publicKey)}`);
