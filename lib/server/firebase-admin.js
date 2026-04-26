"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
var app_1 = require("firebase-admin/app");
var firestore_1 = require("firebase-admin/firestore");
var env_1 = require("@/lib/server/env");
function parseServiceAccount() {
    var encoded = (0, env_1.getRequiredEnv)("FIREBASE_CREDENTIALS_B64");
    var decoded = "";
    try {
        decoded = Buffer.from(encoded, "base64").toString("utf8");
    }
    catch (_a) {
        throw new Error("Failed to decode FIREBASE_CREDENTIALS_B64");
    }
    var parsed;
    try {
        parsed = JSON.parse(decoded);
    }
    catch (_b) {
        throw new Error("Failed to parse Firebase credentials JSON");
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid Firebase credentials payload");
    }
    return parsed;
}
function getOrCreateFirebaseApp() {
    var existing = (0, app_1.getApps)()[0];
    if (existing) {
        return existing;
    }
    return (0, app_1.initializeApp)({
        credential: (0, app_1.cert)(parseServiceAccount()),
    });
}
function getDb() {
    return (0, firestore_1.getFirestore)(getOrCreateFirebaseApp());
}
