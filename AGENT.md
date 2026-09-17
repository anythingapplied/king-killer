I would like to create a mobile friendly (mobile first?) website to play kingkiller.  You can find the rules in rules.md.  Feel free to use any technology stack for the most part, but I would data to be housed in sqlite (if needed) and game logic should be in rust because I want to reuse the logic in OpenSpiel for game theory calculations.

* I've included an image from a kingkiller app.  It shows cards in tavern, cards in discard, active enemy, remaining enemies at current tier, current enemy health, current enemy attack, current enemy, number of jokers available (single player only), available cards to play, number of cards in the play area.  Multiplayer should also include the hand size of all other players.
* Please download card images for me to use and make sure they have a license that allows me to use them.
* For now, the website should support multiplayer, but shouldn't support log in or lobbies. Maybe we'll add those later.
* This is a nixos machine, feel free to use devenv for dependencies

## Workflow

* Commit and push each feature to git as you build it, with a concise commit message describing what was done.
