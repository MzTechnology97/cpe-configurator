package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.security.QuickLogin
import it.cdanet.cpeconfigurator.ui.screens.AiAllowMode
import it.cdanet.cpeconfigurator.ui.screens.aiAllowMode
import it.cdanet.cpeconfigurator.ui.screens.aiDecisionError
import it.cdanet.cpeconfigurator.ui.screens.networkTabTitles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** «Approvazioni dei PC» in the app: who sees the tab and how «Consenti» is confirmed. */
class AiAssistantTest {
    private fun saved(strong: Boolean, persistent: Boolean) =
        QuickLogin.Saved(backend = "https://app.example.invalid", username = "admin", deviceId = "00000000-0000-4000-8000-000000000000", iv = "", data = "", strong = strong, persistent = persistent)

    @Test
    fun tabOnlyForAdminsWithTheModuleOn() {
        assertTrue("Approvazioni dei PC" in networkTabTitles(mapOf("ai_assistant" to true), admin = true, isAdmin = true))
        assertFalse("off by default", "Approvazioni dei PC" in networkTabTitles(emptyMap(), admin = true, isAdmin = true))
        assertFalse("specialist with full view: no", "Approvazioni dei PC" in networkTabTitles(mapOf("ai_assistant" to true), admin = true, isAdmin = false))
        assertEquals(
            "existing tabs unchanged",
            listOf("Stato", "Assistente rete", "Albo", "Guasti", "Aree e avvisi", "AP vicini"),
            networkTabTitles(mapOf("albo" to true), admin = true),
        )
    }

    @Test
    fun allowWithFingerprintOnlyWithAStrongNonPersistentKey() {
        assertEquals(AiAllowMode.Biometric, aiAllowMode(saved(strong = true, persistent = false)))
        assertEquals(AiAllowMode.Code, aiAllowMode(saved(strong = false, persistent = false)))
        assertEquals(AiAllowMode.Code, aiAllowMode(saved(strong = false, persistent = true)))
        assertEquals(AiAllowMode.Code, aiAllowMode(null))
    }

    @Test
    fun errorsInItalian() {
        assertEquals("Comando sensibile: si consente solo sul PC, davanti allo schermo", aiDecisionError("409 local_only"))
        assertTrue(aiDecisionError("401 invalid_device").contains("codice"))
        assertEquals("Decisione non riuscita", aiDecisionError(null))
    }
}
