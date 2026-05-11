import Foundation
import ActivityKit

public struct Peak65LiveActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var exerciseName: String
        public var targetDisplay: String
        public var remainingSecs: Int
        public var nextExerciseName: String
        public var nextTargetDisplay: String
        public var elapsedSecs: Int
        public var stationIndex: Int
        public var totalStations: Int
        public var currentPace: String
        public var isRest: Bool
        public var timerEndDate: Date?
    }
    public var sessionName: String
}
