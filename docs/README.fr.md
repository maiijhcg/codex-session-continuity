<div align="center">

# codex session continuity

**Un relais bien préparé pour vos longues tâches Codex.**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![Un relais bien préparé pour vos longues tâches Codex.](images/hero.png)

</div>

Un assistant Windows pour conserver l’historique local, préparer une note de transmission et poursuivre dans le même projet. La nouvelle tâche lit cette note puis consulte les preuves nécessaires ; toute la conversation n’est pas réinjectée dans le prompt.

> [!IMPORTANT]
> Aperçu expérimental indépendant, sans affiliation officielle à OpenAI. Les interfaces locales de l’application peuvent évoluer. L’automatisation est en pause après une nouvelle installation : vérifiez la fenêtre de contexte effective et les seuils avant de l’activer.

## Ce que fait le programme

![Ce que fait le programme](images/overview.png)

| Fonction | Description |
| --- | --- |
| Conserver les traces | Archivage incrémental des conversations et sorties d’outils déjà enregistrées, avec index de recherche. |
| Préparer la transmission | L’assistant d’origine consigne décisions, avancement, limites, vérifications et prochaines étapes. |
| Garder le même projet | Vérification du projet, du dossier et des permissions, sans changer le checkout ni les fichiers non commités. |
| Conserver les pièces jointes | Copie des fichiers locaux ou intégrés compatibles, avec leur provenance. Une copie ne signifie pas une compréhension du contenu. |

## Trois étapes

![Trois étapes](images/workflow.png)

1. Archiver les enregistrements locaux et les références des pièces jointes.
2. Préparer HANDOFF.md dans la tâche d’origine, avec un jeton de confirmation unique.
3. Créer une seule nouvelle tâche après la fin du tour d’origine et les vérifications.

## Installation sous Windows

Prérequis : Codex Desktop connecté, Node.js 24+ et PowerShell 7+. Enregistrez le dossier exact comme projet dans l’application. Créez une tâche de gestion distincte et copiez son UUID ou lien ; elle ne doit pas être la tâche à poursuivre.

Téléchargez le ZIP et SHA256SUMS depuis Releases, vérifiez le SHA-256 puis décompressez. Ouvrez PowerShell 7 dans ce dossier et remplacez le texte indicatif ci-dessous par l’UUID réel de la tâche de gestion.

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

L’installation se fait par défaut dans `%LOCALAPPDATA%\CodexSessionContinuity`. Le démarrage à la connexion Windows est activé pour l’utilisateur courant : le programme tourne en arrière-plan après redémarrage et connexion, sans droits administrateur. Ce n’est pas un service avant connexion. L’automatisation démarre en pause et conserve ensuite votre choix.

`-NoStartup` désactive l’inscription au démarrage, `-NoStart` diffère le lancement, `-InstallDir` et `-CodexHome` définissent les dossiers, `-SoftLimit`/`-HardLimit` les seuils. Omettez `-WithIntegration` pour différer le hook et les consignes. Le hook doit être examiné via la procédure normale de confiance de Codex, jamais approuvé automatiquement.

## Commandes manuelles

![Commandes manuelles](images/control.png)

| Touche | Action |
| --- | --- |
| **1** | Activer la poursuite automatique |
| **2** | Suspendre l’automatisation ; l’archivage continue |
| **3** | Actualiser processus, connexion et demandes |
| **4** | Choisir explicitement une tâche, par numéro, UUID ou lien complet |
| **5** | Choisir et mémoriser la langue |
| **0** | Quitter sans changer le réglage |

Commencez par 3 pour vérifier processus, signal de vie récent et connexion, puis utilisez 1 ou 4. Les tâches actives sont prioritaires, puis classées par activité récente. Une demande en file n’est pas terminée ; les sélections répétées réutilisent la demande existante.

Le menu est en anglais par défaut et propose anglais, chinois traditionnel, chinois simplifié, japonais et espagnol. Cette documentation est aussi disponible en français, coréen, russe et allemand ; le menu français n’est pas encore fourni. Les titres, historiques et diagnostics techniques restent dans leur langue d’origine. 5 mémorise la langue ; `-Language` s’applique à une seule exécution.

```powershell
.\Codex-Session-Continuity.cmd -Language en
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language en -Json
```

## Seuils et limites

Les exemples utilisent 500 000 (souple) et 920 000 (dur), des valeurs inadaptées à certains modèles. Le seuil souple exige un franchissement observé pendant une surveillance continue. Au démarrage ou à la reprise, un franchissement manqué n’est pas rejoué : le seuil dur reste applicable. La compaction native peut utiliser un autre compteur ou une fenêtre plus petite. Aucun réglage du modèle n’est changé et sa capacité de contexte n’augmente pas.

## Données et sécurité

Le dossier installé contient des données privées dans `archive/`, `notes/`, les `assets/` d’exécution, SQLite, la configuration et les journaux. Ne les publiez pas sur GitHub. Aucun client supplémentaire de télémétrie ou d’envoi cloud n’est ajouté ; les messages et créations de tâches Codex passent toujours par votre compte et service existants.

Aucune suppression automatique de l’historique ou des médias. Surveillez l’espace disque et sauvegardez séparément. Le programme ne fournit ni chiffrement, ni OCR, ni transcription audio, et ne télécharge pas silencieusement les fichiers distants. La pause n’annule pas les opérations envoyées ; l’arrêt du processus arrête aussi le nouvel archivage.

[SECURITY.md](../SECURITY.md)

## Attente et erreurs

`waiting_handoff` attend la tâche source ; `soft_expired` ne rejoue pas une notification souple périmée ; après `checkpoint_interrupted`, vous décidez de resélectionner ou non la tâche. Pour `checkpoint_uncertain`/`creation_uncertain`, vérifiez le résultat avant tout renvoi. Un écart de projet ou de permissions bloque l’opération, sans autre dossier choisi ni élévation automatique.

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## Démarrage, mise à jour et retrait

Exécutez les commandes suivantes depuis le dossier installé. Avant une mise à jour, arrêtez le processus, sauvegardez le dossier privé complet puis réinstallez au même endroit. Le retrait conserve programme, réglages, historique, notes et pièces jointes ; il ne supprime pas les tâches Codex.

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[Guide Windows complet en anglais](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

Aucune licence publique n’a encore été choisie ; MIT ou GPL ne sont pas implicites. Voir NOTICE.md. Les illustrations originales ImageGen sont des schémas conceptuels, pas des captures réelles ni des garanties.

## Langue des instructions et droits hérités

Les notifications à la session d’origine et les instructions de la suivante sont disponibles en neuf langues : `en`, `zh-Hant`, `zh-Hans`, `ja`, `es`, `fr`, `ko`, `ru`, `de`. Elles utilisent l’anglais par défaut ou la langue enregistrée par l’option 5. Pour une nouvelle installation, ajoutez `-HandoffLanguage fr`. Sinon, arrêtez le processus, ajoutez `"handoffLanguage": "fr"` dans `config.json`, puis redémarrez. La mise à jour conserve les réglages ; supprimez cette propriété pour suivre le menu. Un `-Language` temporaire ne modifie pas les messages de fond. La langue reste fixe pendant un transfert ; titres originaux, chemins, commandes, droits et codes de confirmation ne sont pas traduits.

La nouvelle session hérite automatiquement du sandbox et des approbations effectifs de la précédente, indépendamment des valeurs globales ou de la tâche de gestion. Une source en lecture seule doit rester ainsi même si la valeur globale est Full access. Le mécanisme normal de Codex est utilisé, avec contrôle avant envoi et vérification des écritures autorisées, du réseau et du profil après création. Si la source change, elle est relue ; en cas d’incertitude ou d’écart, l’ID est conservé et l’opération s’arrête. Aucun relèvement de droits, changement global ou doublon n’est effectué. Une source en lecture seule incapable d’écrire HANDOFF.md nécessite le processus normal d’autorisation de l’utilisateur. L’ancienne version locale n’est pas mise à jour automatiquement.

