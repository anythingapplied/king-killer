const fs = require('fs');
const path = require('path');

const outputDir = '/home/dan/Projects/kingkiller/frontend/public/cards/';

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = [
    { code: 'H', name: 'HEARTS' },
    { code: 'D', name: 'DIAMONDS' },
    { code: 'C', name: 'CLUBS' },
    { code: 'S', name: 'SPADES' }
];

const suitPaths = {
    CLUBS: `
    <g transform="translate(100, 195) scale(1.2) translate(-50, -50)">
        <g transform="translate(5, 5) rotate(45, 45, 45)">
            <path fill="#16a34a" stroke="black" stroke-width="2" d="M45,2 L57,30 L53,70 L37,70 L33,30 Z"/>
            <path fill="#4ade80" opacity="0.5" stroke="black" stroke-width="0.5" d="M45,10 L50,30 L48,65 L42,65 L40,30 Z"/>
            <path fill="#16a34a" stroke="black" stroke-width="2" d="M25,68 L65,68 L70,76 L20,76 Z"/>
            <rect fill="#16a34a" stroke="black" stroke-width="2" x="40" y="76" width="10" height="12"/>
            <circle fill="#16a34a" stroke="black" stroke-width="2" cx="45" cy="92" r="6"/>
        </g>
        <g transform="translate(-5, 5) rotate(-45, 55, 45)">
            <path fill="#16a34a" stroke="black" stroke-width="2" d="M55,2 L67,30 L63,70 L47,70 L43,30 Z"/>
            <path fill="#4ade80" opacity="0.5" stroke="black" stroke-width="0.5" d="M55,10 L60,30 L58,65 L52,65 L50,30 Z"/>
            <path fill="#16a34a" stroke="black" stroke-width="2" d="M35,68 L75,68 L80,76 L30,76 Z"/>
            <rect fill="#16a34a" stroke="black" stroke-width="2" x="50" y="76" width="10" height="12"/>
            <circle fill="#16a34a" stroke="black" stroke-width="2" cx="55" cy="92" r="6"/>
        </g>
    </g>`,
    SPADES: `
    <g transform="translate(100, 195) scale(1.3) translate(-50, -50)">
        <path fill="#2563eb" stroke="black" stroke-width="2" d="M20,10 L80,10 L80,50 C80,75 50,95 50,95 C50,95 20,75 20,50 Z"/>
        <path fill="#60a5fa" opacity="0.5" stroke="black" stroke-width="0.5" d="M30,20 L70,20 L70,48 C70,65 50,82 50,82 C50,82 30,65 30,48 Z"/>
    </g>`,
    HEARTS: `
    <g transform="translate(100, 195) scale(1.3) translate(-50, -50)">
        <path fill="#dc2626" stroke="black" stroke-width="2" d="M50,90 C50,90 10,65 10,35 A20,20 0 0,1 50,35 A20,20 0 0,1 90,35 C90,65 50,90 50,90 Z"/>
        <path fill="#f87171" opacity="0.5" stroke="black" stroke-width="0.5" d="M50,80 C50,80 20,60 20,40 A15,15 0 0,1 50,40 A15,15 0 0,1 80,40 C80,60 50,80 50,80 Z"/>
    </g>`,
    DIAMONDS: `
    <g transform="translate(100, 195) scale(1.3) translate(-50, -50)">
        <path fill="#ea580c" stroke="black" stroke-width="2" d="M50,5 L80,50 L50,95 L20,50 Z"/>
        <path fill="#fb923c" opacity="0.5" stroke="black" stroke-width="0.5" d="M50,20 L70,50 L50,80 L30,50 Z"/>
    </g>`
};

function generateCard(rank, suit) {
    const isRoyalty = ['J', 'Q', 'K'].includes(rank);
    const border = isRoyalty ? '<rect x="4" y="4" width="192" height="272" rx="8" fill="none" stroke="#7c3aed" stroke-width="8" />' : '';
    
    return `<svg width="200" height="280" viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="280" rx="12" fill="white" />
  ${border}
  <text x="100" y="110" text-anchor="middle" font-family="system-ui, sans-serif" font-size="70" font-weight="900" fill="#1e293b">${rank}</text>
  ${suitPaths[suit.name]}
</svg>`;
}

function generateJoker() {
    return `<svg width="200" height="280" viewBox="0 0 200 280" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="280" rx="12" fill="white" />
  <g transform="translate(100, 140)">
    <!-- Jester Hat -->
    <path fill="#7c3aed" d="M-40,0 Q-40,-60 0,-40 Q40,-60 40,0 L0,20 Z" />
    <circle fill="#7c3aed" cx="-40" cy="-60" r="8" />
    <circle fill="#7c3aed" cx="0" cy="-70" r="8" />
    <circle fill="#7c3aed" cx="40" cy="-60" r="8" />
    
    <!-- Smiley Face -->
    <circle cx="0" cy="40" r="30" fill="none" stroke="#1e293b" stroke-width="3" />
    <circle cx="-10" cy="35" r="3" fill="#1e293b" />
    <circle cx="10" cy="35" r="3" fill="#1e293b" />
    <path d="M-15,50 Q0,65 15,50" fill="none" stroke="#1e293b" stroke-width="3" stroke-linecap="round" />
  </g>
  
  <!-- Vertical JOKER text -->
  <g font-family="system-ui, sans-serif" font-size="20" font-weight="900" fill="#7c3aed">
    <text x="25" y="60" text-anchor="middle">J</text>
    <text x="25" y="85" text-anchor="middle">O</text>
    <text x="25" y="110" text-anchor="middle">K</text>
    <text x="25" y="135" text-anchor="middle">E</text>
    <text x="25" y="160" text-anchor="middle">R</text>
  </g>
  <g font-family="system-ui, sans-serif" font-size="20" font-weight="900" fill="#7c3aed">
    <text x="175" y="60" text-anchor="middle">J</text>
    <text x="175" y="85" text-anchor="middle">O</text>
    <text x="175" y="110" text-anchor="middle">K</text>
    <text x="175" y="135" text-anchor="middle">E</text>
    <text x="175" y="160" text-anchor="middle">R</text>
  </g>
</svg>`;
}

// Generate standard cards
for (const rank of ranks) {
    for (const suit of suits) {
        const fileName = `${rank}${suit.code}.svg`;
        const content = generateCard(rank, suit);
        fs.writeFileSync(path.join(outputDir, fileName), content);
    }
}

// Generate Joker
fs.writeFileSync(path.join(outputDir, 'Joker.svg'), generateJoker());

console.log('Successfully generated 53 cards.');
