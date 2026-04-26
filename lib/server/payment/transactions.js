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
exports.PAYMENT_TRANSACTIONS_COLLECTION = void 0;
exports.createMinimalTransaction = createMinimalTransaction;
exports.createOrGetPaymentTransaction = createOrGetPaymentTransaction;
exports.getPaymentTransaction = getPaymentTransaction;
exports.patchPhase2Transaction = patchPhase2Transaction;
exports.completePhase2Transaction = completePhase2Transaction;
exports.ensurePaymentTransactionState = ensurePaymentTransactionState;
exports.transitionPaymentTransactionState = transitionPaymentTransactionState;
exports.patchPaymentTransaction = patchPaymentTransaction;
exports.listTransactionsForReconciliation = listTransactionsForReconciliation;
exports.listStaleTransactionsForReconciliation = listStaleTransactionsForReconciliation;
exports.claimTransactionRecovery = claimTransactionRecovery;
exports.releaseTransactionRecovery = releaseTransactionRecovery;
exports.assertRecoveryFence = assertRecoveryFence;
exports.guardedPatchPaymentTransaction = guardedPatchPaymentTransaction;
exports.guardedTransitionPaymentTransactionState = guardedTransitionPaymentTransactionState;
var firestore_1 = require("firebase-admin/firestore");
var firebase_admin_1 = require("@/lib/server/firebase-admin");
var errors_1 = require("@/lib/server/payment/errors");
exports.PAYMENT_TRANSACTIONS_COLLECTION = "transactions";
function createMinimalTransaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        var now, record, docRef;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    now = new Date();
                    record = {
                        phone: input.phone,
                        amount: input.amount,
                        status: "pending_payment",
                        unlockStarted: false,
                        createdAt: now,
                        updatedAt: now,
                    };
                    return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .add(record)];
                case 1:
                    docRef = _a.sent();
                    return [2 /*return*/, {
                            id: docRef.id,
                            record: record,
                        }];
            }
        });
    });
}
function createOrGetPaymentTransaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef, now, nowTs;
        var _this = this;
        return __generator(this, function (_a) {
            db = (0, firebase_admin_1.getDb)();
            docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
            now = Date.now();
            nowTs = firestore_1.Timestamp.now();
            return [2 /*return*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                    var snap, existing, record;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, tx.get(docRef)];
                            case 1:
                                snap = _a.sent();
                                if (snap.exists) {
                                    existing = snap.data();
                                    return [2 /*return*/, { created: false, record: existing }];
                                }
                                record = {
                                    id: input.id,
                                    status: "initiated",
                                    phone: input.phone,
                                    station: input.station,
                                    amount: input.amount,
                                    providerRef: null,
                                    unlockStarted: false,
                                    rentalCreated: false,
                                    createdAt: now,
                                    updatedAt: now,
                                };
                                tx.set(docRef, __assign(__assign({}, record), { createdAtTs: nowTs, updatedAtTs: nowTs }));
                                return [2 /*return*/, { created: true, record: record }];
                        }
                    });
                }); })];
        });
    });
}
function getPaymentTransaction(id) {
    return __awaiter(this, void 0, void 0, function () {
        var snap;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                        .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                        .doc(id)
                        .get()];
                case 1:
                    snap = _a.sent();
                    if (!snap.exists) {
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, __assign({ id: id }, snap.data())];
            }
        });
    });
}
function patchPhase2Transaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                        .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                        .doc(input.id)
                        .set(__assign(__assign({}, input.patch), { updatedAt: firestore_1.Timestamp.now() }), { merge: true })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function completePhase2Transaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef;
        var _this = this;
        return __generator(this, function (_a) {
            db = (0, firebase_admin_1.getDb)();
            docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
            return [2 /*return*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                    var snap, current;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, tx.get(docRef)];
                            case 1:
                                snap = _a.sent();
                                if (!snap.exists) {
                                    throw new errors_1.HttpError(404, "Transaction record not found", {
                                        transactionId: input.id,
                                    });
                                }
                                current = snap.data();
                                if (current.status === "paid" || current.status === "failed") {
                                    return [2 /*return*/, current.status];
                                }
                                if (current.status !== "pending_payment") {
                                    throw new errors_1.HttpError(409, "invalid state", {
                                        transactionId: input.id,
                                        expectedState: "pending_payment",
                                        actualState: current.status,
                                    });
                                }
                                tx.update(docRef, __assign({ status: input.status, updatedAt: firestore_1.Timestamp.now() }, (input.failureReason ? { failureReason: input.failureReason } : {})));
                                return [2 /*return*/, input.status];
                        }
                    });
                }); })];
        });
    });
}
function ensurePaymentTransactionState(id, expected) {
    return __awaiter(this, void 0, void 0, function () {
        var record;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, getPaymentTransaction(id)];
                case 1:
                    record = _a.sent();
                    if (!record) {
                        throw new errors_1.HttpError(404, "Transaction record not found", {
                            transactionId: id,
                        });
                    }
                    if (record.status !== expected) {
                        throw new errors_1.HttpError(409, "invalid state", {
                            transactionId: id,
                            expectedState: expected,
                            actualState: record.status,
                        });
                    }
                    return [2 /*return*/, record];
            }
        });
    });
}
function transitionPaymentTransactionState(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef;
        var _this = this;
        return __generator(this, function (_a) {
            db = (0, firebase_admin_1.getDb)();
            docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
            return [2 /*return*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                    var snap, current, now, nextDoc;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, tx.get(docRef)];
                            case 1:
                                snap = _a.sent();
                                if (!snap.exists) {
                                    throw new errors_1.HttpError(404, "Transaction record not found", {
                                        transactionId: input.id,
                                    });
                                }
                                current = snap.data();
                                if (current.status !== input.from) {
                                    throw new errors_1.HttpError(409, "invalid state", {
                                        transactionId: input.id,
                                        expectedState: input.from,
                                        actualState: current.status,
                                    });
                                }
                                now = Date.now();
                                nextDoc = __assign({ status: input.to, updatedAt: now, updatedAtTs: firestore_1.Timestamp.now() }, (input.patch || {}));
                                tx.update(docRef, nextDoc);
                                return [2 /*return*/, __assign(__assign({}, current), nextDoc)];
                        }
                    });
                }); })];
        });
    });
}
function patchPaymentTransaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, firebase_admin_1.getDb)()
                        .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                        .doc(input.id)
                        .set(__assign(__assign({}, input.patch), { updatedAt: Date.now(), updatedAtTs: firestore_1.Timestamp.now() }), { merge: true })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function listTransactionsForReconciliation() {
    return __awaiter(this, arguments, void 0, function (limit) {
        var db, _a, capturedSnap, unknownSnap, inProgressSnap, verifiedSnap, byId, _i, _b, doc, tx, _c, _d, doc, _e, _f, doc, _g, _h, doc, tx;
        if (limit === void 0) { limit = 50; }
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    db = (0, firebase_admin_1.getDb)();
                    return [4 /*yield*/, Promise.all([
                            db
                                .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                                .where("status", "==", "captured")
                                .limit(limit)
                                .get(),
                            db
                                .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                                .where("status", "==", "capture_unknown")
                                .limit(limit)
                                .get(),
                            db
                                .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                                .where("status", "==", "capture_in_progress")
                                .limit(limit)
                                .get(),
                            db
                                .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                                .where("status", "==", "verified")
                                .limit(limit)
                                .get(),
                        ])];
                case 1:
                    _a = _j.sent(), capturedSnap = _a[0], unknownSnap = _a[1], inProgressSnap = _a[2], verifiedSnap = _a[3];
                    byId = new Map();
                    for (_i = 0, _b = capturedSnap.docs; _i < _b.length; _i++) {
                        doc = _b[_i];
                        tx = doc.data();
                        if (!tx.rentalCreated) {
                            byId.set(doc.id, tx);
                        }
                    }
                    for (_c = 0, _d = unknownSnap.docs; _c < _d.length; _c++) {
                        doc = _d[_c];
                        byId.set(doc.id, doc.data());
                    }
                    for (_e = 0, _f = inProgressSnap.docs; _e < _f.length; _e++) {
                        doc = _f[_e];
                        byId.set(doc.id, doc.data());
                    }
                    for (_g = 0, _h = verifiedSnap.docs; _g < _h.length; _g++) {
                        doc = _h[_g];
                        tx = doc.data();
                        if (tx.captureAttempted) {
                            byId.set(doc.id, tx);
                        }
                    }
                    return [2 /*return*/, Array.from(byId.values())];
            }
        });
    });
}
function listStaleTransactionsForReconciliation() {
    return __awaiter(this, arguments, void 0, function (limit) {
        var db, now, confirmationCutoff, captureInProgressCutoff, confirmSnap, capturedSnap, pendingSnap, captureInProgressSnap, verifiedCrashSnap, results, _i, _a, doc, _b, _c, doc, _d, _e, doc, tx, _f, _g, doc, _h, _j, doc;
        if (limit === void 0) { limit = 20; }
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    db = (0, firebase_admin_1.getDb)();
                    now = Date.now();
                    confirmationCutoff = now - 120000;
                    captureInProgressCutoff = now - 60000;
                    return [4 /*yield*/, db
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .where("status", "==", "confirm_required")
                            .where("confirmRequiredAt", "<", confirmationCutoff)
                            .orderBy("confirmRequiredAt")
                            .limit(limit)
                            .get()];
                case 1:
                    confirmSnap = _k.sent();
                    return [4 /*yield*/, db
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .where("status", "==", "captured")
                            .orderBy("updatedAt")
                            .limit(limit * 2)
                            .get()];
                case 2:
                    capturedSnap = _k.sent();
                    return [4 /*yield*/, db
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .where("status", "==", "pending_payment")
                            .orderBy("updatedAt")
                            .limit(limit)
                            .get()];
                case 3:
                    pendingSnap = _k.sent();
                    return [4 /*yield*/, db
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .where("status", "==", "capture_in_progress")
                            .where("captureAttemptedAt", "<", captureInProgressCutoff)
                            .orderBy("captureAttemptedAt")
                            .limit(limit)
                            .get()];
                case 4:
                    captureInProgressSnap = _k.sent();
                    return [4 /*yield*/, db
                            .collection(exports.PAYMENT_TRANSACTIONS_COLLECTION)
                            .where("status", "==", "verified")
                            .where("captureAttempted", "==", true)
                            .limit(limit)
                            .get()];
                case 5:
                    verifiedCrashSnap = _k.sent();
                    results = [];
                    // Add confirm_required
                    for (_i = 0, _a = confirmSnap.docs; _i < _a.length; _i++) {
                        doc = _a[_i];
                        results.push(doc.data());
                    }
                    // Add pending_payment
                    for (_b = 0, _c = pendingSnap.docs; _b < _c.length; _b++) {
                        doc = _c[_b];
                        if (results.length >= limit)
                            break;
                        results.push(doc.data());
                    }
                    // Add captured without rental (only up to limit)
                    for (_d = 0, _e = capturedSnap.docs; _d < _e.length; _d++) {
                        doc = _e[_d];
                        if (results.length >= limit)
                            break;
                        tx = doc.data();
                        if (!tx.rentalCreated) {
                            results.push(tx);
                        }
                    }
                    // Phase 4: Add stale capture_in_progress
                    for (_f = 0, _g = captureInProgressSnap.docs; _f < _g.length; _f++) {
                        doc = _g[_f];
                        if (results.length >= limit)
                            break;
                        results.push(doc.data());
                    }
                    // Phase 4: Add verified + captureAttempted crash cases
                    for (_h = 0, _j = verifiedCrashSnap.docs; _h < _j.length; _h++) {
                        doc = _j[_h];
                        if (results.length >= limit)
                            break;
                        results.push(doc.data());
                    }
                    return [2 /*return*/, results];
            }
        });
    });
}
function claimTransactionRecovery(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef, now, leaseUntil;
        var _this = this;
        return __generator(this, function (_a) {
            db = (0, firebase_admin_1.getDb)();
            docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.id);
            now = Date.now();
            leaseUntil = now + input.leaseMs;
            return [2 /*return*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                    var snap, current, activeLease, nextRecoveryVersion;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, tx.get(docRef)];
                            case 1:
                                snap = _a.sent();
                                if (!snap.exists) {
                                    return [2 /*return*/, null];
                                }
                                current = snap.data();
                                activeLease = typeof current.recoveryLeaseUntil === "number" &&
                                    current.recoveryLeaseUntil > now &&
                                    current.recoveryWorkerId &&
                                    current.recoveryWorkerId !== input.workerId;
                                if (activeLease) {
                                    return [2 /*return*/, null];
                                }
                                nextRecoveryVersion = (current.recoveryVersion || 0) + 1;
                                tx.update(docRef, {
                                    recoveryWorkerId: input.workerId,
                                    recoveryLeaseUntil: leaseUntil,
                                    recoveryAttempts: (current.recoveryAttempts || 0) + 1,
                                    recoveryVersion: nextRecoveryVersion,
                                    updatedAt: now,
                                    updatedAtTs: firestore_1.Timestamp.now(),
                                });
                                return [2 /*return*/, {
                                        record: current,
                                        recoveryVersion: nextRecoveryVersion,
                                    }];
                        }
                    });
                }); })];
        });
    });
}
function releaseTransactionRecovery(id, workerId, recoveryVersion) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    db = (0, firebase_admin_1.getDb)();
                    docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(id);
                    return [4 /*yield*/, db.runTransaction(function (tx) { return __awaiter(_this, void 0, void 0, function () {
                            var snap, current;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, tx.get(docRef)];
                                    case 1:
                                        snap = _a.sent();
                                        if (!snap.exists) {
                                            return [2 /*return*/];
                                        }
                                        current = snap.data();
                                        if (current.recoveryWorkerId !== workerId) {
                                            return [2 /*return*/];
                                        }
                                        if (typeof recoveryVersion === "number" &&
                                            (current.recoveryVersion || 0) !== recoveryVersion) {
                                            return [2 /*return*/];
                                        }
                                        tx.update(docRef, {
                                            recoveryLeaseUntil: null,
                                            recoveryWorkerId: null,
                                            updatedAt: Date.now(),
                                            updatedAtTs: firestore_1.Timestamp.now(),
                                        });
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function assertRecoveryFence(fence) {
    return __awaiter(this, void 0, void 0, function () {
        var tx;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, getPaymentTransaction(fence.id)];
                case 1:
                    tx = _a.sent();
                    if (!tx) {
                        throw new Error("Transaction missing during fenced operation");
                    }
                    if (tx.recoveryWorkerId !== fence.workerId) {
                        throw new Error("Recovery fence rejected: worker mismatch");
                    }
                    if ((tx.recoveryVersion || 0) !== fence.recoveryVersion) {
                        throw new Error("Recovery fence rejected: stale version");
                    }
                    if (typeof tx.recoveryLeaseUntil === "number" &&
                        tx.recoveryLeaseUntil < Date.now()) {
                        throw new Error("Recovery fence rejected: lease expired");
                    }
                    return [2 /*return*/, tx];
            }
        });
    });
}
function guardedPatchPaymentTransaction(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef, now;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    db = (0, firebase_admin_1.getDb)();
                    docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.fence.id);
                    now = Date.now();
                    return [4 /*yield*/, db.runTransaction(function (txn) { return __awaiter(_this, void 0, void 0, function () {
                            var snap, current;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, txn.get(docRef)];
                                    case 1:
                                        snap = _a.sent();
                                        if (!snap.exists) {
                                            throw new Error("Transaction missing during guarded patch");
                                        }
                                        current = snap.data();
                                        if (current.recoveryWorkerId !== input.fence.workerId ||
                                            (current.recoveryVersion || 0) !== input.fence.recoveryVersion) {
                                            throw new Error("Recovery fence rejected: stale guarded patch");
                                        }
                                        txn.set(docRef, __assign(__assign({}, input.patch), { updatedAt: now, updatedAtTs: firestore_1.Timestamp.now() }), { merge: true });
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function guardedTransitionPaymentTransactionState(input) {
    return __awaiter(this, void 0, void 0, function () {
        var db, docRef;
        var _this = this;
        return __generator(this, function (_a) {
            db = (0, firebase_admin_1.getDb)();
            docRef = db.collection(exports.PAYMENT_TRANSACTIONS_COLLECTION).doc(input.fence.id);
            return [2 /*return*/, db.runTransaction(function (txn) { return __awaiter(_this, void 0, void 0, function () {
                    var snap, current, now, nextDoc;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, txn.get(docRef)];
                            case 1:
                                snap = _a.sent();
                                if (!snap.exists) {
                                    throw new Error("Transaction missing during guarded transition");
                                }
                                current = snap.data();
                                if (current.recoveryWorkerId !== input.fence.workerId ||
                                    (current.recoveryVersion || 0) !== input.fence.recoveryVersion) {
                                    throw new Error("Recovery fence rejected: stale guarded transition");
                                }
                                if (current.status !== input.from) {
                                    throw new errors_1.HttpError(409, "invalid state", {
                                        transactionId: input.fence.id,
                                        expectedState: input.from,
                                        actualState: current.status,
                                    });
                                }
                                now = Date.now();
                                nextDoc = __assign({ status: input.to, updatedAt: now, updatedAtTs: firestore_1.Timestamp.now() }, (input.patch || {}));
                                txn.update(docRef, nextDoc);
                                return [2 /*return*/, __assign(__assign({}, current), nextDoc)];
                        }
                    });
                }); })];
        });
    });
}
