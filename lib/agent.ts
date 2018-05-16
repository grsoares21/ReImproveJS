import {Memento, Memory} from "./memory";
import {Model} from "./model";
import {Tensor, tensor, tensor2d} from "@tensorflow/tfjs-core";
import {range, random} from "lodash";
import {TypedWindow} from "./window";

const MEM_WINDOW_MIN_SIZE = 2;
const HIST_WINDOW_SIZE = 1000;
const HIST_WINDOW_MIN_SIZE = 10;

export interface LearningConfig {
    gamma?: number;
    epsilon?: number;
    epsilonDecay?: number;
    epsilonMin?: number;
    learningRate?: number;
    learningTime?: number;
    learningStepsRandom?: number;
}

export interface AgentConfig {
    memorySize: number;
    batchSize: number;
    temporalWindow: number;
    learningConfig?: LearningConfig;
}

export interface TrackingInformation {
    age: number;
    forwardPasses: number;
    learning: boolean;
    averageLoss: number;
    averageReward: number;
}

export class Agent {
    private done: boolean;
    private track: TrackingInformation;
    private currentReward: number;

    private actionsBuffer: Array<number>;
    private statesBuffer: Array<Tensor>;
    private inputsBuffer: Array<Tensor>;

    private rewardsHistory: TypedWindow<number>;
    private lossesHistory: TypedWindow<number>;
    private netInputWindowSize: number;

    constructor(private model: Model, private config: AgentConfig, private memory: Memory = new Memory({memorySize: config.memorySize})) {
        this.done = false;
        this.track = {age: 0, forwardPasses: 0, learning: true, averageLoss: 0, averageReward: 0};
        this.currentReward = 0;

        this.rewardsHistory = new TypedWindow<number>(HIST_WINDOW_SIZE, HIST_WINDOW_MIN_SIZE);
        this.lossesHistory = new TypedWindow<number>(HIST_WINDOW_SIZE, HIST_WINDOW_MIN_SIZE);

        this.netInputWindowSize = Math.max(this.config.temporalWindow, MEM_WINDOW_MIN_SIZE);
        this.actionsBuffer = new Array(this.netInputWindowSize);
        this.inputsBuffer = new Array(this.netInputWindowSize);
        this.statesBuffer = new Array(this.netInputWindowSize);
    }

    private createNeuralNetInput(input: Tensor): Tensor {
        let finalInput = input.clone();

        for (let i = 0; i < this.config.temporalWindow; ++i) {
            finalInput = finalInput.concat(this.statesBuffer[this.netInputWindowSize - 1 - i], 1);

            let ten = tensor([
                range(0, this.model.OutputSize)
                    .map((val) => val == this.actionsBuffer[this.netInputWindowSize - 1 - i] ? 1.0 : 0.0)
            ]);
            finalInput = finalInput.concat(ten, 1);
        }

        return finalInput;
    }

    private policy(input: Tensor): number {
        return this.model.predict(input).getHighestValue();
    }

    forward(input: Tensor): number {
        this.track.forwardPasses += 1;

        // First we check we're learning
        if (this.track.age < this.config.learningConfig.learningTime) {
            // Then we verify if we're always taking random actions or if we can start decaying epsilon parameter
            if (this.track.age > this.config.learningConfig.learningStepsRandom &&
                this.config.learningConfig.epsilon > this.config.learningConfig.epsilonMin) {
                this.config.learningConfig.epsilon *= this.config.learningConfig.epsilonDecay;
            }
        }

        let action;
        let netInput;
        if (this.track.forwardPasses > this.config.temporalWindow) {
            netInput = this.createNeuralNetInput(input);

            if (random(0, 1, true) < this.config.learningConfig.epsilon) {
                // Select a random action according to epsilon probability
                action = this.model.randomOutput();
            } else {
                // Or just use our policy
                action = this.policy(netInput);
            }
        } else {
            // Case in the beginnings
            action = this.model.randomOutput();
            netInput = tensor([]);
        }

        this.actionsBuffer.shift();
        this.actionsBuffer.push(action);
        this.statesBuffer.shift();
        this.statesBuffer.push(input);
        this.inputsBuffer.shift();
        this.inputsBuffer.push(netInput);

        return action;
    }


    backward(): void {
        this.rewardsHistory.add(this.currentReward);

        this.track.age += 1;

        if (!this.track.learning || this.track.forwardPasses <= this.config.temporalWindow+1) return;
        // Save experience
        this.memory.remember({
            action: this.actionsBuffer[this.netInputWindowSize - MEM_WINDOW_MIN_SIZE],
            reward: this.currentReward,
            state: this.inputsBuffer[this.netInputWindowSize - MEM_WINDOW_MIN_SIZE],
            nextState: this.inputsBuffer[this.netInputWindowSize - 1]
        });

        if (this.memory.Length <= this.config.learningConfig.learningStepsRandom) return;
        this.replay();

    }

    private replay() {
        const trainData = this.memory.sample(this.config.batchSize)
            .map(memento => this.createInOutFromMemento(memento))
            .reduce((previousValue, currentValue) => {
                return {x: previousValue.x.concat(currentValue.x), y: previousValue.y.concat(currentValue.y)};
            });
        this.model.fit(trainData.x, trainData.y, {epochs:1, stepsPerEpoch:1})
            .then(
                result => this.lossesHistory.add(<number>result.history.loss[0]),
                reason => {throw new Error("Unable to realize fit correctly");}
            );
        this.setReward(0.);
    }

    createInOutFromMemento(memento: Memento): {x: Tensor, y: Tensor} {
        let target = memento.reward;
        if (!this.done) {
            target = memento.reward + this.config.learningConfig.gamma * this.model.predict(memento.nextState).getHighestValue();
        }

        let future_target = this.model.predict(memento.state).getValue();
        future_target[memento.action] = target;
        return {x: memento.state, y: tensor2d(future_target, [1, 3])};
    }

    addReward(value: number): void {
        this.currentReward += value;
    }

    setReward(value: number): void {
        this.currentReward = value;
    }
}