/* ============================================================================
   ENERGY BODIES — CROWD EDITION — INITIALIZATION SCRIPT
   Load this file BEFORE sketch.js in your HTML.
   Same API surface as the single-person project: sketch.js binds the real
   implementations onto these hooks once it's loaded, so control.html can call
   them immediately without caring about load order.
   ============================================================================ */

console.log('[EB-INIT] Loading initialization script...');

// Global state
window.__ebSession = null;
window.__ebSessionReady = false;
window.__ebTrackingStarted = false;

// Queue for delayed operations
let sessionStartQueued = false;
let trackingStartQueued = false;

/* =============================
   SESSION MANAGEMENT
   ============================= */

// Session will be created by sketch.js, but API is available immediately
window.beginSession = function () {
    console.log('[EB-INIT] beginSession() called');

    if (window.__ebSession && window.__ebSessionReady) {
        try {
            window.__ebSession.begin();
            console.log('[SESSION] Started');
            return true;
        } catch (e) {
            console.error('[SESSION] Error starting:', e);
            return false;
        }
    } else {
        console.log('[SESSION] Not ready yet - queuing start request');
        sessionStartQueued = true;
        return false;
    }
};

window.endSession = function () {
    console.log('[EB-INIT] endSession() called');

    if (window.__ebSession && window.__ebSessionReady && window.__ebSession.active) {
        try {
            const result = window.__ebSession.end();
            console.log('[SESSION] Ended:', result);
            return result;
        } catch (e) {
            console.error('[SESSION] Error ending:', e);
            return null;
        }
    } else {
        console.warn('[SESSION] No active session to end');
        return null;
    }
};

/* =============================
   TRACKING CONTROLS
   ============================= */

window.startTracking = function () {
    console.log('[EB-INIT] startTracking() called');

    if (window.__ebTrackingReady) {
        // Real implementation exists in sketch.js
        if (window.__ebStartTrackingImpl) {
            window.__ebStartTrackingImpl();
        }
    } else {
        console.log('[TRACKING] Not ready yet - queuing start request');
        trackingStartQueued = true;
    }
};

window.stopTracking = function () {
    console.log('[EB-INIT] stopTracking() called');

    if (window.__ebTrackingReady && window.__ebStopTrackingImpl) {
        window.__ebStopTrackingImpl();
    } else {
        console.warn('[TRACKING] Stop function not ready');
    }
};

/* =============================
   PRINT HANDLER
   ============================= */

window.onPrint = function () {
    console.log('[EB-INIT] onPrint() called');

    if (typeof window.__ebPrintImpl === 'function') {
        window.__ebPrintImpl();
    } else {
        console.error('[PRINT] Print handler not ready');
    }
};

/* =============================
   READY CHECK & QUEUE PROCESSOR
   ============================= */

window.__ebProcessQueued = function () {
    console.log('[EB-INIT] Processing queued operations...');

    // Process queued session start
    if (sessionStartQueued && window.__ebSession && window.__ebSessionReady) {
        console.log('[EB-INIT] Starting queued session');
        window.beginSession();
        sessionStartQueued = false;
    }

    // Process queued tracking start
    if (trackingStartQueued && window.__ebTrackingReady) {
        console.log('[EB-INIT] Starting queued tracking');
        window.startTracking();
        trackingStartQueued = false;
    }
};

// Status check function for debugging
window.__ebStatus = function () {
    return {
        sessionExists: !!window.__ebSession,
        sessionReady: window.__ebSessionReady,
        sessionActive: window.__ebSession?.active || false,
        trackingReady: window.__ebTrackingReady || false,
        trackingStarted: window.__ebTrackingStarted || false,
        queuedSession: sessionStartQueued,
        queuedTracking: trackingStartQueued
    };
};

console.log('[EB-INIT] Initialization complete - APIs ready');
console.log('[EB-INIT] Status:', window.__ebStatus());
