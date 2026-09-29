package net.midgardrp.badge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.Minecraft;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class MidgardBadgeClient implements ClientModInitializer {

    private static final Logger LOGGER = LoggerFactory.getLogger("MidgardBadge");
    private static final String API_URL = "https://midgard-badge-api.midgard-badge-api.workers.dev";
    private static final String API_KEY = "midgard-badge-2026-MidgardRP";

    private static volatile Set<UUID> BADGED_PLAYERS = Collections.emptySet();
    private static volatile UUID selfUuid = null;
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private static ScheduledExecutorService scheduler;

    public static boolean hasBadge(UUID uuid) {
        return BADGED_PLAYERS.contains(uuid);
    }

    @Override
    public void onInitializeClient() {
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            try {
                UUID localId = Minecraft.getInstance().getUser().getProfileId();
                if (localId != null) {
                    selfUuid = localId;
                    BADGED_PLAYERS = Collections.singleton(localId);
                }
            } catch (Exception ignored) {}
            startHeartbeat();
        });

        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            stopHeartbeat();
            sendLeave();
            BADGED_PLAYERS = Collections.emptySet();
            selfUuid = null;
        });
    }

    private static void startHeartbeat() {
        stopHeartbeat();
        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "Midgard-Badge");
            t.setDaemon(true);
            return t;
        });
        scheduler.scheduleAtFixedRate(MidgardBadgeClient::heartbeat, 5, 30, TimeUnit.SECONDS);
    }

    private static void stopHeartbeat() {
        if (scheduler != null && !scheduler.isShutdown()) {
            scheduler.shutdownNow();
            scheduler = null;
        }
    }

    private static String normalizeServer(String ip) {
        String s = ip.toLowerCase(Locale.ROOT).trim();
        if (s.endsWith(":25565")) {
            s = s.substring(0, s.length() - 6);
        }
        return s;
    }

    private static void heartbeat() {
        try {
            Minecraft mc = Minecraft.getInstance();
            var serverData = mc.getCurrentServer();
            if (serverData == null) {
                LOGGER.debug("No server data, skipping heartbeat");
                return;
            }

            String uuid = mc.getUser().getProfileId().toString();
            String server = normalizeServer(serverData.ip);

            LOGGER.debug("Sending heartbeat - uuid={}, server={}", uuid, server);

            String body = "{\"uuid\":\"" + uuid + "\",\"server\":\"" + server + "\"}";

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(API_URL + "/heartbeat"))
                    .header("Content-Type", "application/json")
                    .header("X-Api-Key", API_KEY)
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(5))
                    .build();

            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());

            if (res.statusCode() == 200) {
                JsonArray arr = JsonParser.parseString(res.body())
                        .getAsJsonObject().getAsJsonArray("players");
                Set<UUID> updated = new HashSet<>();
                for (JsonElement el : arr) {
                    try {
                        updated.add(UUID.fromString(el.getAsString()));
                    } catch (Exception ignored) {}
                }
                // Always include self — if this mod is running, we are a launcher user
                if (selfUuid != null) {
                    updated.add(selfUuid);
                }
                BADGED_PLAYERS = Collections.unmodifiableSet(updated);
                LOGGER.debug("Badged players updated: {}", updated.size());
            } else {
                LOGGER.warn("Heartbeat returned status {}", res.statusCode());
            }
        } catch (Exception e) {
            LOGGER.debug("Heartbeat failed: {}", e.getMessage());
        }
    }

    private static void sendLeave() {
        try {
            Minecraft mc = Minecraft.getInstance();
            String uuid = mc.getUser().getProfileId().toString();
            String body = "{\"uuid\":\"" + uuid + "\"}";

            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(API_URL + "/leave"))
                    .header("Content-Type", "application/json")
                    .header("X-Api-Key", API_KEY)
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .timeout(Duration.ofSeconds(3))
                    .build();

            HTTP.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (Exception ignored) {}
    }
}
