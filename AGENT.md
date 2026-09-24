I would like to create a mobile friendly (mobile first?) website to play King Killer.  The rules as implemented live in king-killer-core.  Feel free to use any technology stack for the most part, but I would data to be housed in sqlite (if needed) and game logic should be in rust because I want to reuse the logic in OpenSpiel for game theory calculations.

* The board should show: cards in the tavern, cards in the discard pile, the active enemy with its health and attack, the remaining enemies at the current tier, jokers available (single player only), the cards available to play, and the number of cards in the play area.  Multiplayer should also show the hand size of every other player.
* Please download card images for me to use and make sure they have a license that allows me to use them.
* For now, the website should support multiplayer, but shouldn't support log in or lobbies. Maybe we'll add those later.
* This is a nixos machine, feel free to use devenv for dependencies

## Workflow

* Commit and push each feature to git as you build it, with a concise commit message describing what was done.
