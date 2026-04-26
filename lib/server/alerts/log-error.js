"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRITICAL_ERROR_TYPES = void 0;
exports.logError = logError;
var firebase_admin_1 = require("@/lib/server/firebase-admin");
var whatsapp_1 = require("@/lib/server/alerts/whatsapp");
exports.CRITICAL_ERROR_TYPES = {
    VERIFICATION_FAILED: "VERIFICATION_FAILED",
    CAPTURE_UNKNOWN: "CAPTURE_UNKNOWN",
    RECONCILIATION_FAILED: "RECONCILIATION_FAILED",
    SYSTEM_INCONSISTENCY: "SYSTEM_INCONSISTENCY",
    DELIVERY_VERIFICATION: "DELIVERY_VERIFICATION",
    FALSE_EJECTION_PATTERN: "FALSE_EJECTION_PATTERN",
    VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT",
    // Phase 4: Financial safety alerts (Tier 1 — WhatsApp immediate)
    CAPTURE_INCONSISTENCY: "CAPTURE_INCONSISTENCY_DETECTED",
    CAPTURE_RETRY_EXHAUSTED: "CAPTURE_RETRY_EXHAUSTED",
    RENTAL_CREATION_FAILED: "RENTAL_CREATION_FAILED",
    CAPTURE_FAIL_BLOCKED: "CAPTURE_FAIL_BLOCKED",
    SLA_BREACH_DETECTED: "SLA_BREACH_DETECTED",
};
// --- In-memory tracking for deduplication ---
var lastAlertSent = new Map();
function isDuplicateAlert(transactionId, type) {
    if (!transactionId)
        return false;
    var key = "".concat(transactionId, "_").concat(type);
    var now = Date.now();
    var last = lastAlertSent.get(key);
    if (last && now - last < 10000) {
        return true;
    }
    // Cleanup memory map
    if (lastAlertSent.size > 500) {
        for (var _i = 0, _a = lastAlertSent.entries(); _i < _a.length; _i++) {
            var _b = _a[_i], k = _b[0], v = _b[1];
            if (now - v > 60000)
                lastAlertSent.delete(k);
        }
    }
    return false;
}
function markAlertSent(transactionId, type) {
    if (!transactionId)
        return;
    var key = "".concat(transactionId, "_").concat(type);
    lastAlertSent.set(key, Date.now());
}
function detectStationFailures(stationCode) {
    return __awaiter(this, void 0, void 0, function () {
        var now, db, ref, alertTriggered, err_1;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!stationCode)
                        return [2 /*return*/];
                    now = Date.now();
                    db = (0, firebase_admin_1.getDb)();
                    ref = db.collection("station_failures").doc(stationCode);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                            var doc, failures;
                            var _a;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0: return [4 /*yield*/, tx.get(ref)];
                                    case 1:
                                        doc = _b.sent();
                                        failures = [];
                                        if (doc.exists) {
                                            failures = ((_a = doc.data()) === null || _a === void 0 ? void 0 : _a.timestamps) || [];
                                        }
                                        failures = failures.filter(function (t) { return now - t <= 10 * 60 * 1000; });
                                        failures.push(now);
                                        tx.set(ref, { stationCode: stationCode, timestamps: failures }, { merge: true });
                                        return [2 /*return*/, failures.length === 5]; // Exactly 5 triggers the alert to prevent spam
                                }
                            });
                        }); })];
                case 2:
                    alertTriggered = _a.sent();
                    if (!alertTriggered) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, whatsapp_1.sendWhatsAppAlertWithResult)("\u26A0\uFE0F Station ".concat(stationCode, " likely broken (5+ failures in 10 min)"))];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4: return [3 /*break*/, 6];
                case 5:
                    err_1 = _a.sent();
                    console.error("[ALERT_EXCEPTION] Failed to track/send station broken alert for ".concat(stationCode, ":"), err_1);
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function queueDurableAlert(input) {
    return __awaiter(this, void 0, void 0, function () {
        var error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                            .collection("alerts_queue")
                            .add({
                            type: input.type,
                            transactionId: input.transactionId || null,
                            message: formatAlert(input),
                            retries: 0,
                            nextAttemptAt: Date.now() + 5000,
                            createdAt: Date.now(),
                        })];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    error_1 = _a.sent();
                    console.error("[CRITICAL] Failed to enqueue durable alert:", error_1 instanceof Error ? error_1.message : String(error_1), "Payload:", formatAlert(input));
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function isCriticalErrorType(type) {
    return Object.values(exports.CRITICAL_ERROR_TYPES).includes(type);
}
function formatAlert(input) {
    return [
        "DANAB ALERT",
        "Type: ".concat(input.type),
        "Station: ".concat(input.stationCode || "-"),
        "Phone: ".concat(input.phoneNumber || "-"),
        "Tx (Idempotency): ".concat(input.transactionId || "-"),
        "Provider Ref: ".concat(input.providerRef || "-"),
        "Message: ".concat(input.message),
    ].join("\n");
}
/**
 * Structured error logger with guaranteed visibility.
 *
 * GUARANTEES:
 * 1. Critical errors are ALWAYS written to console (defense-in-depth)
 * 2. Firestore write is attempted; if it fails, full payload is dumped to console
 * 3. WhatsApp alert is attempted for critical types; if rate-limited, alert
 *    content is logged to console so server logs always contain it
 * 4. This function NEVER throws — it returns a result describing what happened
 */
function logError(input) {
    return __awaiter(this, void 0, void 0, function () {
        var isCritical, logged, error_2, lockRef, e_1, alertStatus, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    isCritical = isCriticalErrorType(input.type);
                    // GUARANTEE: Critical errors always appear in runtime logs regardless
                    // of Firestore/WhatsApp success. This is the last line of defense.
                    if (isCritical) {
                        console.error("[CRITICAL_ERROR] ".concat(formatAlert(input)), input.metadata ? JSON.stringify(input.metadata) : "");
                    }
                    logged = false;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                            .collection("errors")
                            .add(__assign(__assign(__assign(__assign(__assign(__assign(__assign({ type: input.type }, (input.transactionId ? { transactionId: input.transactionId } : {})), (input.providerRef ? { providerRef: input.providerRef } : {})), (input.stationCode ? { stationCode: input.stationCode } : {})), (input.phoneNumber ? { phoneNumber: input.phoneNumber } : {})), { message: input.message }), (input.metadata ? { metadata: input.metadata } : {})), { createdAt: Date.now() }))];
                case 2:
                    _a.sent();
                    logged = true;
                    return [3 /*break*/, 4];
                case 3:
                    error_2 = _a.sent();
                    // Firestore write failed — dump full payload to console so it is
                    // NEVER silently lost. Container/runtime logs become the fallback.
                    console.error("[CRITICAL] Failed to write error to Firestore — dumping full payload:", JSON.stringify({
                        type: input.type,
                        transactionId: input.transactionId,
                        providerRef: input.providerRef,
                        stationCode: input.stationCode,
                        phoneNumber: input.phoneNumber,
                        message: input.message,
                        metadata: input.metadata,
                        firestoreError: error_2 instanceof Error ? error_2.message : String(error_2),
                    }));
                    return [3 /*break*/, 4];
                case 4:
                    if (input.stationCode) {
                        void detectStationFailures(input.stationCode);
                    }
                    // Only attempt WhatsApp alert for critical error types
                    if (!isCritical) {
                        return [2 /*return*/, { logged: logged, alertStatus: null }];
                    }
                    if (!input.transactionId) return [3 /*break*/, 9];
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 7, , 8]);
                    lockRef = (0, firebase_admin_1.getDb)().collection("alert_locks").doc("".concat(input.transactionId, "_").concat(input.type));
                    return [4 /*yield*/, lockRef.create({ createdAt: Date.now() })];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 7:
                    e_1 = _a.sent();
                    if (e_1.code === 6) { // ALREADY_EXISTS
                        console.warn("[ALERT_DEDUPLICATED] Skipping duplicate alert for Tx: ".concat(input.transactionId, ", Type: ").concat(input.type));
                        return [2 /*return*/, { logged: logged, alertStatus: null }];
                    }
                    return [3 /*break*/, 8];
                case 8: return [3 /*break*/, 10];
                case 9:
                    if (isDuplicateAlert(input.transactionId, input.type)) {
                        // Fallback to in-memory deduplication if no transactionId
                        console.warn("[ALERT_DEDUPLICATED] Skipping duplicate alert for Tx: unknown, Type: ".concat(input.type));
                        return [2 /*return*/, { logged: logged, alertStatus: null }];
                    }
                    _a.label = 10;
                case 10:
                    _a.trys.push([10, 15, , 17]);
                    return [4 /*yield*/, (0, whatsapp_1.sendWhatsAppAlertWithResult)(formatAlert(input))];
                case 11:
                    alertStatus = _a.sent();
                    if (!(alertStatus === "sent")) return [3 /*break*/, 12];
                    markAlertSent(input.transactionId, input.type);
                    return [3 /*break*/, 14];
                case 12:
                    if (!(alertStatus === "rate_limited" || alertStatus === "failed")) return [3 /*break*/, 14];
                    // Step 5: Queue durable alert for retry
                    return [4 /*yield*/, queueDurableAlert(input)];
                case 13:
                    // Step 5: Queue durable alert for retry
                    _a.sent();
                    _a.label = 14;
                case 14:
                    // Logging side-effects
                    if (alertStatus === "rate_limited") {
                        console.error("[ALERT_RATE_LIMITED] WhatsApp alert rate-limited — enqueued for eventual delivery:", formatAlert(input));
                    }
                    else if (alertStatus === "missing_config") {
                        console.error("[ALERT_NO_CONFIG] WhatsApp not configured — critical alert NOT sent:", formatAlert(input));
                    }
                    else if (alertStatus === "failed") {
                        console.error("[ALERT_FAILED] WhatsApp alert delivery failed — enqueued for eventual delivery:", formatAlert(input));
                    }
                    return [2 /*return*/, { logged: logged, alertStatus: alertStatus }];
                case 15:
                    error_3 = _a.sent();
                    console.error("[ALERT_EXCEPTION] Unexpected WhatsApp alert failure. Enqueuing for eventual delivery. Error:", error_3 instanceof Error ? error_3.message : error_3, "— alert content:", formatAlert(input));
                    return [4 /*yield*/, queueDurableAlert(input)];
                case 16:
                    _a.sent();
                    return [2 /*return*/, { logged: logged, alertStatus: "failed" }];
                case 17: return [2 /*return*/];
            }
        });
    });
}
