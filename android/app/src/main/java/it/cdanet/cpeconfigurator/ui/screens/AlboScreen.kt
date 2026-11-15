package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.AlboDto
import it.cdanet.cpeconfigurator.data.AlboItemDto
import it.cdanet.cpeconfigurator.ui.Badge
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.RefreshButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.Tone
import it.cdanet.cpeconfigurator.ui.WarnAmber
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.launch

/** The acts shown for a kind ("all", "albo", "bandi") and a text searched in municipality, subject and words. */
fun alboFilter(items: List<AlboItemDto>, kind: String, query: String): List<AlboItemDto> {
    val q = query.trim().lowercase()
    return items
        .filter { kind == "all" || it.kind == kind }
        .filter { q.isEmpty() || it.comune.lowercase().contains(q) || it.title.lowercase().contains(q) || it.keywords.any { k -> k.lowercase().contains(q) } }
}

/**
 * «Albo e permessi» (Rete → Albo, who sees everything, module albo): the acts of the albo pretorio on
 * digs, fibre, antennas and telecommunications and the calls for tenders on connectivity of the
 * municipalities chosen in the console. The lists and the words are set in the console; here the
 * acts, the link to each one and, for admins, «Controlla ora».
 */
@Composable
fun AlboScreen(c: AppContainer) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var data by remember { mutableStateOf<AlboDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf<String?>(null) }
    var kind by remember { mutableStateOf("all") }
    var query by remember { mutableStateOf("") }

    suspend fun load() {
        busy = true
        runCatching { c.api.albo() }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        busy = false
    }
    LaunchedEffect(c.refresh.collectAsState().value) { load() }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ErrorBanner(error) { error = null }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Atti su reti e bandi nei comuni scelti", fontWeight = FontWeight.SemiBold)
                Text(
                    data?.status?.at?.let { "Ultimo controllo ${localTime(it)} · ogni ora" } ?: "Controllo ogni ora: comuni e parole si scelgono nella console",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            RefreshButton(busy) { scope.launch { load() } }
        }
        data?.status?.takeIf { !it.ok }?.error?.let { Text("Ultimo controllo con errori: $it", color = WarnAmber, style = MaterialTheme.typography.bodySmall) }
        if (c.session.isAdmin) {
            BusyButton("Controlla ora", checking, Modifier.fillMaxWidth(), primary = false) {
                scope.launch {
                    checking = true
                    runCatching { c.api.alboCheck() }
                        .onSuccess { info = if (it.ok) "Controllo fatto: ${it.fresh} atti nuovi" else "Controllo fatto con errori: ${it.error}"; load() }
                        .onFailure { error = it.message }
                    checking = false
                }
            }
            info?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("all" to "Tutti", "albo" to "Albo", "bandi" to "Bandi").forEach { (k, label) ->
                FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(label) })
            }
        }
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Cerca comune o parola") }, singleLine = true)
        val d = data ?: run {
            if (busy) it.cdanet.cpeconfigurator.ui.SkeletonRows(3)
            return@Column
        }
        val shown = alboFilter(d.items, kind, query)
        if (shown.isEmpty()) {
            SectionCard { Text(if (d.items.isEmpty()) "Nessun atto con le parole scelte. Comuni ed elenchi si aggiungono nella console, in Albo e permessi." else "Nessun atto con questo filtro.") }
            return@Column
        }
        shown.forEach { a ->
            SectionCard(modifier = Modifier.fillMaxWidth().clickable(enabled = a.url.isNotBlank()) { runCatching { uri.openUri(a.url) } }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(a.comune, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Badge(if (a.kind == "bandi") "bando" else "albo", if (a.kind == "bandi") Tone.Brand else Tone.Info)
                }
                Text(a.title, style = MaterialTheme.typography.bodyMedium)
                if (a.keywords.isNotEmpty()) Text(a.keywords.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    listOfNotNull(a.firstSeen?.let { "Trovato ${localTime(it)}" }, if (a.notified) "avvisato" else "già presente al primo controllo", a.url.takeIf { it.isNotBlank() }?.let { "tocca per aprire l’atto" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
