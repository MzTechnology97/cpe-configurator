package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AlboDto
import it.cdanet.cpeconfigurator.data.AlboItemDto
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.screens.alboFilter
import it.cdanet.cpeconfigurator.ui.screens.networkTabTitles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** «Albo e permessi» in the app (made-up municipalities and acts). */
class AlboTest {
    private val items = listOf(
        AlboItemDto(id = "1", comune = "Comune di Esempio", kind = "albo", title = "Scavi in minitrincea per fibra ottica", keywords = listOf("fibra", "scavi")),
        AlboItemDto(id = "2", comune = "Altro Comune", kind = "bandi", title = "Gara per connettività negli uffici", keywords = listOf("connettivita")),
        AlboItemDto(id = "3", comune = "Altro Comune", kind = "albo", title = "Nuova stazione radio base", keywords = listOf("stazione radio base", "srb")),
    )

    @Test
    fun tabOnlyForWhoSeesEverythingWithTheModuleOn() {
        assertTrue("Albo" in networkTabTitles(mapOf("albo" to true), admin = true))
        assertFalse("off by default: unknown means off", "Albo" in networkTabTitles(emptyMap(), admin = true))
        assertFalse("Albo" in networkTabTitles(mapOf("albo" to false), admin = true))
        assertFalse("Albo" in networkTabTitles(mapOf("albo" to true), admin = false))
        assertEquals(listOf("Stato", "IA-AP", "Albo", "Guasti", "Aree e avvisi", "AP vicini"), networkTabTitles(mapOf("albo" to true), admin = true))
    }

    @Test
    fun filtersByKindAndText() {
        assertEquals(listOf("1", "2", "3"), alboFilter(items, "all", "").map { it.id })
        assertEquals(listOf("1", "3"), alboFilter(items, "albo", "").map { it.id })
        assertEquals(listOf("2"), alboFilter(items, "bandi", " ").map { it.id })
        assertEquals(listOf("2", "3"), alboFilter(items, "all", "altro").map { it.id })
        assertEquals(listOf("3"), alboFilter(items, "all", "SRB").map { it.id })
        assertEquals(listOf("1"), alboFilter(items, "albo", "fibra").map { it.id })
    }

    @Test
    fun readsTheServerAnswer() {
        val json = """{"config":{"sources":[]},"states":{},"status":{"at":"2026-11-15T10:00:00.000Z","ok":false,"error":"1 elenchi non letti su 2","sources":2,"fresh":1},
            "items":[{"id":"a","sourceId":"s","comune":"Comune di Esempio","kind":"bandi","title":"Bando Wi-Fi","url":"https://bandi.example.it/1","publishedAt":null,"keywords":["wifi"],"firstSeen":"2026-11-15T10:00:00.000Z","notified":true}]}"""
        val d = AppJson.decodeFromString(AlboDto.serializer(), json)
        assertEquals("1 elenchi non letti su 2", d.status!!.error)
        assertEquals("bandi", d.items[0].kind)
        assertEquals(listOf("wifi"), d.items[0].keywords)
        assertTrue(d.items[0].notified)
    }
}
