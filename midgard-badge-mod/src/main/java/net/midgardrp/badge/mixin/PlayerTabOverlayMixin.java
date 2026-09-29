package net.midgardrp.badge.mixin;

import net.midgardrp.badge.MidgardBadgeClient;
import net.minecraft.client.gui.components.PlayerTabOverlay;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerTabOverlay.class)
public class PlayerTabOverlayMixin {

    @Inject(method = "getNameForDisplay", at = @At("RETURN"), cancellable = true)
    private void midgard$addBadge(PlayerInfo playerInfo, CallbackInfoReturnable<Component> cir) {
        if (MidgardBadgeClient.hasBadge(playerInfo.getProfile().getId())) {
            MutableComponent name = Component.empty().append(cir.getReturnValue());
            MutableComponent icon = Component.literal(" \uE100")
                    .withStyle(style -> style.withColor(0xFFFFFF));
            cir.setReturnValue(name.append(icon));
        }
    }
}
