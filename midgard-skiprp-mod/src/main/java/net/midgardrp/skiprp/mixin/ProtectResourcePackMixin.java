package net.midgardrp.skiprp.mixin;

import net.minecraft.client.gui.screens.packs.PackSelectionModel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Prevents the MidgardRP resource pack from being deselected, moved, or modified
 * from the in-game Resource Packs screen.
 */
@Mixin(targets = "net.minecraft.client.gui.screens.packs.PackSelectionModel$EntryBase")
public abstract class ProtectResourcePackMixin implements PackSelectionModel.Entry {

    @Shadow
    public abstract String getId();

    private boolean isMidgardPack() {
        String id = getId();
        return id != null && id.contains("MidgardRP_Texture");
    }

    // Block deselection (moving from Selected -> Available)
    @Inject(method = "toggleSelection", at = @At("HEAD"), cancellable = true)
    private void midgard$preventToggle(CallbackInfo ci) {
        if (isMidgardPack()) {
            ci.cancel();
        }
    }

    // Block moving up/down to prevent reordering
    @Inject(method = "move", at = @At("HEAD"), cancellable = true)
    private void midgard$preventMove(int direction, CallbackInfo ci) {
        if (isMidgardPack()) {
            ci.cancel();
        }
    }

    // Report as required so Minecraft shows the lock icon
    @Inject(method = "isRequired", at = @At("HEAD"), cancellable = true)
    private void midgard$forceRequired(CallbackInfoReturnable<Boolean> cir) {
        if (isMidgardPack()) {
            cir.setReturnValue(true);
        }
    }

    // Report as fixed position so it can't be reordered
    @Inject(method = "isFixedPosition", at = @At("HEAD"), cancellable = true)
    private void midgard$forceFixed(CallbackInfoReturnable<Boolean> cir) {
        if (isMidgardPack()) {
            cir.setReturnValue(true);
        }
    }
}
