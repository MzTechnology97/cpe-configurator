package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AiRequestDto
import it.cdanet.cpeconfigurator.security.QuickLogin
import it.cdanet.cpeconfigurator.security.QuickLoginCancelled
import it.cdanet.cpeconfigurator.ui.Badge
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.RefreshButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.Tone
import it.cdanet.cpeconfigurator.ui.fragmentActivity
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How «Consenti» is confirmed on this phone. */
enum class AiAllowMode { Biometric, Code }

/**
 * A strong fingerprint or face unlocks the phone's key (the server checks it); a «persistent» phone
 * (opens with no prompt) or a weak biometric only gates the prompt, so they need the code instead.
 */
fun aiAllowMode(saved: QuickLogin.Saved?): AiAllowMode = if (saved != null && saved.strong && !saved.persistent) AiAllowMode.Biometric else AiAllowMode.Code

/** Italian message for the errors of the decision. */
fun aiDecisionError(message: String?): String = when {
    message == null -> "Decisione non riuscita"
    "local_only" in message -> "Comando sensibile: si consente solo sul PC, davanti allo schermo"
    "invalid_device" in message -> "Impronta non accettata dal server: usa il codice di verifica"
    "invalid_code" in message -> "Codice non valido"
    "too_many_code_attempts" in message -> "Troppi tentativi: riprova tra qualche minuto"
    "already_decided" in message -> "Richiesta già decisa o scaduta"
    "not_agent_owner" in message -> "Decide l’amministratore che possiede il PC"
    else -> message
}

/**
 * «Assistente AI» (Rete → Assistente AI, admins, module ai_assistant): the AIs on the PCs ask for
 * permission; deny with a tap, allow with a strong fingerprint/face (the phone's key) or a fresh
 * code. The command is written by an AI: shown as plain monospaced text, in full, never as a link.
 */
@Composable
fun AiAssistantScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var items by remember { mutableStateOf<List<AiRequestDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val deciding = remember { mutableStateMapOf<Long, Boolean>() }
    val codes = remember { mutableStateMapOf<Long, String>() }
    val me = c.session.state.collectAsState().value?.user?.username
    val mode = aiAllowMode(c.quickLogin.saved())

    suspend fun load() {
        busy = true
        runCatching { c.api.aiRequests("pending") }.onSuccess { items = it.requests; error = null }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) {
        // while the tab is open: a request lasts 10 minutes, so a short refresh
        while (true) {
            load()
            delay(15_000)
        }
    }

    fun decide(r: AiRequestDto, allow: Boolean) {
        scope.launch {
            deciding[r.id] = true
            error = null
            try {
                when {
                    !allow -> c.api.aiDecide(r.id, false)
                    mode == AiAllowMode.Biometric -> {
                        val activity = context.fragmentActivity() ?: throw IllegalStateException("Schermata non pronta")
                        val s = c.quickLogin.saved() ?: throw IllegalStateException("Sblocco con impronta non attivo: usa il codice")
                        val cipher = c.quickLogin.decryptCipher(s) ?: throw IllegalStateException("Impronte o volti del telefono cambiati: usa il codice")
                        val unlocked = c.quickLogin.authenticate(activity, "Consenti il comando", "${r.agent} · ${r.tool}", true, cipher)
                        c.api.aiDecide(r.id, true, deviceId = s.deviceId, secret = c.quickLogin.secret(s, unlocked))
                    }
                    else -> c.api.aiDecide(r.id, true, code = codes[r.id].orEmpty().trim())
                }
                info = if (allow) "Consentito: ${r.agent} · ${r.tool}" else "Negato: ${r.agent} · ${r.tool}"
                codes.remove(r.id)
                load()
            } catch (_: QuickLoginCancelled) {
            } catch (e: Exception) {
                error = aiDecisionError(e.message)
            }
            deciding.remove(r.id)
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ErrorBanner(error) { error = null }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Richieste di permesso delle AI", fontWeight = FontWeight.SemiBold)
                Text(
                    if (mode == AiAllowMode.Biometric) "Nega con un tocco, consenti con impronta o volto" else "Nega con un tocco, consenti con un codice di verifica nuovo",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            RefreshButton(busy) { scope.launch { load() } }
        }
        info?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        val list = items ?: run {
            if (busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(3)
            return@Column
        }
        if (list.isEmpty()) {
            SectionCard { Text("Nessuna richiesta in attesa. Senza risposta entro 10 minuti una richiesta vale «negata».") }
            return@Column
        }
        list.forEach { r ->
            val mine = r.owner == me
            SectionCard(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(r.agent, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    if (r.localOnly) Badge("solo dal PC", Tone.Warn)
                }
                Text(
                    listOfNotNull(r.ai.ifBlank { null }, r.tool, r.createdAt?.let { localTime(it) }, r.expiresAt?.let { "scade ${localTime(it)}" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!mine) {
                    Text("Il testo del comando lo vede e decide solo ${r.owner}.", style = MaterialTheme.typography.bodySmall)
                    return@SectionCard
                }
                Text("Testo generato dall’AI, ripulito dei segreti: leggilo tutto prima di decidere.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(r.detail.ifBlank { "(nessun dettaglio)" }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                val busyHere = deciding[r.id] == true
                if (r.localOnly) {
                    Text("Comando sensibile: si consente solo sul PC, davanti allo schermo.", style = MaterialTheme.typography.bodySmall)
                    BusyButton("Nega", busyHere, Modifier.fillMaxWidth(), primary = false) { decide(r, false) }
                } else {
                    if (mode == AiAllowMode.Code) {
                        OutlinedTextField(
                            codes[r.id].orEmpty(),
                            { v -> codes[r.id] = v.filter { ch -> ch.isLetterOrDigit() || ch == '-' }.take(12) },
                            Modifier.fillMaxWidth(),
                            label = { Text("Codice di verifica") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BusyButton("Nega", busyHere, Modifier.weight(1f), primary = false) { decide(r, false) }
                        BusyButton(
                            if (mode == AiAllowMode.Biometric) "Consenti con impronta" else "Consenti",
                            busyHere,
                            Modifier.weight(1f),
                            enabled = mode == AiAllowMode.Biometric || codes[r.id].orEmpty().trim().length >= 6,
                        ) { decide(r, true) }
                    }
                }
            }
        }
    }
}
