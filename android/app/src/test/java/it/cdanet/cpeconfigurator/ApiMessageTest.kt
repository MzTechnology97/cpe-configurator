package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.ApiException
import it.cdanet.cpeconfigurator.data.apiMessage
import it.cdanet.cpeconfigurator.data.blockedIpMessage
import it.cdanet.cpeconfigurator.data.retryLater
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ApiMessageTest {
    @Test
    fun codesNamingADataSourceAreNeverShown() {
        for (code in listOf("uisp_device_not_found", "uisp_error", "crm_unreachable", "uisp_crm_error")) {
            val m = apiMessage(code)
            assertFalse(m, m.contains("uisp", ignoreCase = true) || m.contains("crm", ignoreCase = true))
        }
    }

    @Test
    fun blockedAddressSaysWhichAndWhoUnblocks() {
        val m = blockedIpMessage("203.0.113.9")
        assertTrue(m, m.contains("203.0.113.9") && m.contains("NOC") && m.contains("Accessi bloccati"))
        // never the name of the protection behind it
        assertFalse(m, m.contains("crowdsec", ignoreCase = true))
        assertFalse(blockedIpMessage(null).contains("null"))
    }

    @Test
    fun knownAndUnknownCodes() {
        assertEquals("Codice non valido", apiMessage("invalid_code"))
        assertEquals("something_else", apiMessage("something_else"))
    }

    @Test
    fun queuedWorkWaitsForAnUpdateOrAnUnblock() {
        // a mandatory update (426) or a blocked address must not throw away results, reports and photos
        for ((status, code) in listOf(426 to "client_update_required", 403 to "blocked_ip", 401 to "unauthorized", 503 to "x", 429 to "x")) {
            assertTrue("$status $code", ApiException(status, code, "").retryLater)
        }
        for ((status, code) in listOf(400 to "invalid", 403 to "forbidden", 404 to "job_not_found")) {
            assertFalse("$status $code", ApiException(status, code, "").retryLater)
        }
    }
}
