import React from 'react';
import './Statistics.css';

interface StatisticsProps {
    todayCount: number;
    totalCount: number;
}

export const Statistics: React.FC<StatisticsProps> = ({ todayCount, totalCount }) => {
    return (
        <div className="section">
            <h3>Statistics</h3>
            <div className="stats">
                <div className="stat-item">
                    <span className="stat-label">Today:</span>
                    <span className="stat-value">{todayCount}</span>
                </div>
                <div className="stat-item">
                    <span className="stat-label">Total:</span>
                    <span className="stat-value">{totalCount}</span>
                </div>
            </div>
        </div>
    );
};
