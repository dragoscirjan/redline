#! /bin/bash

npx -y skills@1.7.4 add https://github.com/dragoscirjan/ai/tree/main/.agents/skills/agentic-work/sync-my-skills \
  --skill sync-my-skills --global --agent pi --yes

pi '/sync-my-skills Read AGENTS.md to understand the nature of the project. Please sync the necessary 
skills that could help me develop and maintain this project and adapt AGENTS.md and its dependencies, 
without altering the core information contained by them.'
